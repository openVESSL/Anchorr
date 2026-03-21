import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import * as tmdbApi from "../api/tmdb.js";
import * as seerrApi from "../api/seerr.js";
import { fetchOMDbData } from "../api/omdb.js";
import { buildNotificationEmbed, buildButtons } from "./embeds.js";
import {
  getOptionStringRobust,
  parseQualityAndServerOptions,
  checkRolePermission,
  getSeerrAutoApprove,
} from "./botUtils.js";
import {
  botState,
  pendingRequests,
  savePendingRequests,
} from "./botState.js";
import { getUserMappings } from "../utils/configFile.js";
import { getSeerrApiUrl } from "../utils/seerrUrl.js";
import logger from "../utils/logger.js";

// Convenience accessors — read process.env at call time so config reloads are respected
const getSeerrUrl = () => getSeerrApiUrl(process.env.SEERR_URL || "");
const getSeerrApiKey = () => process.env.SEERR_API_KEY;
const getTmdbApiKey = () => process.env.TMDB_API_KEY;

// ----------------- COMMON SEARCH LOGIC -----------------
async function handleSearchOrRequest(
  interaction,
  rawInput,
  mode,
  tags = [],
  options = {}
) {
  const isPrivateMode = process.env.PRIVATE_MESSAGE_MODE === "true";

  try {
    await interaction.deferReply({ ephemeral: isPrivateMode });
  } catch (err) {
    logger.error(`Failed to defer reply: ${err.message}`);
    return;
  }

  let tmdbId, mediaType;

  if (rawInput.includes("|")) {
    [tmdbId, mediaType] = rawInput.split("|");
  } else {
    const results = await tmdbApi.tmdbSearch(rawInput, getTmdbApiKey());
    const found = results.filter(
      (r) => r.media_type === "movie" || r.media_type === "tv"
    );
    if (found.length) {
      tmdbId = found[0].id;
      mediaType = found[0].media_type;
    }
  }

  if (!tmdbId || !mediaType) {
    if (isPrivateMode) {
      return interaction.editReply({
        content: "⚠️ The title seems to be invalid.",
      });
    } else {
      await interaction.deleteReply();
      return interaction.followUp({
        content: "⚠️ The title seems to be invalid.",
        flags: 64,
      });
    }
  }

  try {
    const details = await tmdbApi.tmdbGetDetails(
      tmdbId,
      mediaType,
      getTmdbApiKey()
    );

    if (mode === "request") {
      const status = await seerrApi.checkMediaStatus(
        tmdbId,
        mediaType,
        ["all"],
        getSeerrUrl(),
        getSeerrApiKey()
      );

      if (status.exists && status.available) {
        if (isPrivateMode) {
          await interaction.editReply({
            content: "✅ This content is already available in your library!",
            components: [],
            embeds: [],
          });
        } else {
          await interaction.deleteReply();
          await interaction.followUp({
            content: "✅ This content is already available in your library!",
            flags: 64,
          });
        }
        return;
      }

      let tagIds = [];
      if (tags && tags.length > 0) {
        try {
          const allTags = await seerrApi.fetchTags(
            getSeerrUrl(),
            getSeerrApiKey()
          );
          const relevantTags = Array.isArray(allTags)
            ? allTags.filter((tag) =>
              mediaType === "tv" ? tag.type === "sonarr" : tag.type === "radarr"
            )
            : [];

          tagIds = tags
            .map((tagLabel) => {
              const tag = relevantTags.find(
                (t) => (t.label || t.name) === tagLabel
              );
              return tag ? tag.id : null;
            })
            .filter((id) => id !== null);

          logger.debug(
            `Converted tag labels ${tags.join(", ")} to IDs: ${tagIds.join(", ")}`
          );
        } catch (err) {
          logger.warn("Failed to convert tag labels to IDs:", err?.message);
        }
      }

      const { profileId, serverId } = parseQualityAndServerOptions(
        options,
        mediaType
      );

      let seasonsToRequest = ["all"];
      if (mediaType === "tv" && details.seasons) {
        const seasonNumbers = details.seasons
          .filter((s) => s.season_number > 0)
          .map((s) => s.season_number);

        if (seasonNumbers.length > 0) {
          seasonsToRequest = seasonNumbers;
          logger.info(
            `[REQUEST] Resolved 'all' seasons to explicit list: ${seasonsToRequest.join(", ")}`
          );
        }
      }

      await seerrApi.sendRequest({
        tmdbId,
        mediaType,
        seasons: seasonsToRequest,
        tags: tagIds,
        profileId,
        serverId,
        seerrUrl: getSeerrUrl(),
        apiKey: getSeerrApiKey(),
        discordUserId: interaction.user.id,
        userMappings: getUserMappings(),
        isAutoApproved: getSeerrAutoApprove(),
      });
      logger.info(
        `[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}. Auto-Approve: ${getSeerrAutoApprove()}`
      );

      if (process.env.NOTIFY_ON_AVAILABLE === "true") {
        const requestKey = `${tmdbId}-${mediaType}`;
        if (!pendingRequests.has(requestKey)) {
          pendingRequests.set(requestKey, new Set());
        }
        pendingRequests.get(requestKey).add(interaction.user.id);
        savePendingRequests();
      }
    }

    const imdbId = await tmdbApi.tmdbGetExternalImdb(
      tmdbId,
      mediaType,
      getTmdbApiKey()
    );

    const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

    const embed = buildNotificationEmbed(
      details,
      mediaType,
      imdbId,
      mode === "request" ? "success" : "search",
      omdb,
      tmdbId
    );

    const components = buildButtons(
      tmdbId,
      imdbId,
      mode === "request",
      mediaType,
      details
    );

    if (mediaType === "movie" && mode === "search") {
      try {
        const allTags = await seerrApi.fetchTags(
          getSeerrUrl(),
          getSeerrApiKey()
        );

        const radarrTags = Array.isArray(allTags)
          ? allTags.filter((tag) => tag.type === "radarr")
          : [];

        if (radarrTags && radarrTags.length > 0) {
          const uniqueTags = [];
          const seenIds = new Set();

          for (const tag of radarrTags) {
            if (!seenIds.has(tag.id)) {
              seenIds.add(tag.id);
              uniqueTags.push(tag);
            }
          }

          const tagOptions = uniqueTags.slice(0, 25).map((tag) => ({
            label: tag.label || tag.name || `Tag ${tag.id}`,
            value: tag.id.toString(),
          }));

          const tagMenu = new StringSelectMenuBuilder()
            .setCustomId(`select_tags|${tmdbId}|`)
            .setPlaceholder("Select tags (optional)")
            .addOptions(tagOptions)
            .setMinValues(0)
            .setMaxValues(Math.min(5, tagOptions.length));

          const tagRow = new ActionRowBuilder().addComponents(tagMenu);
          components.push(tagRow);
        }
      } catch (err) {
        logger.debug(
          "Failed to fetch tags for movie tag selector:",
          err?.message
        );
      }
    }

    await interaction.editReply({ embeds: [embed], components });
  } catch (err) {
    logger.error("Error in handleSearchOrRequest:", err);

    let errorMessage = "⚠️ An error occurred.";
    if (err.response && err.response.data && err.response.data.message) {
      errorMessage = `⚠️ Seerr error: ${err.response.data.message}`;
    } else if (err.message) {
      if (err.message.includes("403")) {
        errorMessage =
          "⚠️ Request failed: You might have exceeded your quota or don't have permission.";
      } else {
        errorMessage = `⚠️ Error: ${err.message}`;
      }
    }

    if (isPrivateMode) {
      await interaction.editReply({
        content: errorMessage,
        components: [],
        embeds: [],
      });
    } else {
      try {
        await interaction.deleteReply();
      } catch (e) {
        // ignore if already deleted
      }
      await interaction.followUp({
        content: errorMessage,
        flags: 64,
      });
    }
  }
}

// ----------------- REGISTER INTERACTIONS -----------------
export function registerInteractions(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      // Check role permissions for all commands
      if (
        interaction.isCommand() ||
        (interaction.isStringSelectMenu() &&
          !interaction.customId.startsWith("request_seasons|") &&
          !interaction.customId.startsWith("request_with_tags|"))
      ) {
        if (!checkRolePermission(interaction.member)) {
          return interaction.reply({
            content: "❌ You don't have permission to use this command.",
            flags: 64,
          });
        }
      }

      // Autocomplete
      if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        const focusedValue = focusedOption.value;

        // Handle Tag Autocomplete
        if (focusedOption.name === "tag") {
          try {
            const allTags = await seerrApi.fetchTags(
              getSeerrUrl(),
              getSeerrApiKey()
            );

            const filteredTags = Array.isArray(allTags)
              ? allTags.filter((tag) => {
                const label = tag.label || tag.name || "";
                return label
                  .toLowerCase()
                  .includes(focusedValue.toLowerCase());
              })
              : [];

            const uniqueTags = [];
            const seenLabels = new Set();

            for (const tag of filteredTags) {
              const label = tag.label || tag.name;
              if (label && !seenLabels.has(label)) {
                seenLabels.add(label);
                uniqueTags.push({
                  name: label,
                  value: label,
                });
              }
            }

            return await interaction.respond(uniqueTags.slice(0, 25));
          } catch (e) {
            logger.error("Tag autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Handle Quality Profile Autocomplete
        if (focusedOption.name === "quality") {
          try {
            const titleOption = interaction.options.getString("title");
            let mediaType = null;

            if (titleOption && titleOption.includes("|")) {
              const parts = titleOption.split("|");
              mediaType = parts[1];
            }

            const serverOption = interaction.options.getString("server");
            let selectedServerId = null;

            if (serverOption && serverOption.includes("|")) {
              const parts = serverOption.split("|");
              const parsedServerId = parseInt(parts[0], 10);

              if (!isNaN(parsedServerId)) {
                selectedServerId = parsedServerId;
              } else {
                logger.warn(
                  `Invalid server option in autocomplete - non-numeric serverId: ${parts[0]}`
                );
              }
            }

            const allProfiles = await seerrApi.fetchQualityProfiles(
              getSeerrUrl(),
              getSeerrApiKey()
            );

            const filteredProfiles = allProfiles.filter((profile) => {
              const name = profile.name || "";
              const matchesSearch = name
                .toLowerCase()
                .includes(focusedValue.toLowerCase());

              let matchesType = true;
              if (mediaType) {
                matchesType =
                  (mediaType === "movie" && profile.type === "radarr") ||
                  (mediaType === "tv" && profile.type === "sonarr");
              }

              let matchesServer = true;
              if (selectedServerId !== null) {
                matchesServer = profile.serverId === selectedServerId;
              }

              return matchesSearch && matchesType && matchesServer;
            });

            const uniqueProfiles = [];
            const seenNames = new Set();

            for (const profile of filteredProfiles) {
              const displayName = `${profile.name} (${profile.serverName})`;
              const key = `${profile.id}-${profile.serverId}`;
              if (!seenNames.has(key)) {
                seenNames.add(key);
                uniqueProfiles.push({
                  name:
                    displayName.length > 100
                      ? displayName.substring(0, 97) + "..."
                      : displayName,
                  value: `${profile.id}|${profile.serverId}|${profile.type}`,
                });
              }
            }

            return await interaction.respond(uniqueProfiles.slice(0, 25));
          } catch (e) {
            logger.error("Quality profile autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Server Autocomplete
        if (focusedOption.name === "server") {
          try {
            const titleOption = interaction.options.getString("title");
            let mediaType = null;

            if (titleOption && titleOption.includes("|")) {
              const parts = titleOption.split("|");
              mediaType = parts[1];
            }

            const allServers = await seerrApi.fetchServers(
              getSeerrUrl(),
              getSeerrApiKey()
            );

            const filteredServers = allServers.filter((server) => {
              const name = server.name || "";
              const matchesSearch = name
                .toLowerCase()
                .includes(focusedValue.toLowerCase());

              if (mediaType) {
                const matchesType =
                  (mediaType === "movie" && server.type === "radarr") ||
                  (mediaType === "tv" && server.type === "sonarr");
                return matchesSearch && matchesType;
              }

              return matchesSearch;
            });

            const serverChoices = filteredServers.map((server) => {
              const typeEmoji = server.type === "radarr" ? "🎬" : "📺";
              const displayName = `${typeEmoji} ${server.name}${server.isDefault ? " (default)" : ""}`;
              return {
                name:
                  displayName.length > 100
                    ? displayName.substring(0, 97) + "..."
                    : displayName,
                value: `${server.id}|${server.type}`,
              };
            });

            return await interaction.respond(serverChoices.slice(0, 25));
          } catch (e) {
            logger.error("Server autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Trending autocomplete
        if (interaction.commandName === "trending") {
          try {
            const trendingResults = await tmdbApi.tmdbGetTrending(
              getTmdbApiKey()
            );
            const filtered = trendingResults
              .filter(
                (r) => r.media_type === "movie" || r.media_type === "tv"
              )
              .filter((r) => {
                const title = r.title || r.name || "";
                return title
                  .toLowerCase()
                  .includes(focusedValue.toLowerCase());
              })
              .slice(0, 10);

            const trendingChoices = await Promise.all(
              filtered.map(async (item) => {
                try {
                  const details = await tmdbApi.tmdbGetDetails(
                    item.id,
                    item.media_type,
                    getTmdbApiKey()
                  );

                  const emoji = item.media_type === "movie" ? "🎬" : "📺";
                  const date =
                    item.release_date || item.first_air_date || "";
                  const year = date ? ` (${date.slice(0, 4)})` : "";

                  let extraInfo = "";
                  if (item.media_type === "movie") {
                    const director = details.credits?.crew?.find(
                      (c) => c.job === "Director"
                    );
                    const directorName = director ? director.name : null;
                    const runtime = details.runtime;
                    const hours = runtime ? Math.floor(runtime / 60) : 0;
                    const minutes = runtime ? runtime % 60 : 0;
                    const runtimeStr = runtime
                      ? `${hours}h ${minutes}m`
                      : null;

                    if (directorName && runtimeStr) {
                      extraInfo = ` — directed by ${directorName} — runtime: ${runtimeStr}`;
                    } else if (directorName) {
                      extraInfo = ` — directed by ${directorName}`;
                    } else if (runtimeStr) {
                      extraInfo = ` — runtime: ${runtimeStr}`;
                    }
                  } else {
                    const creator = details.created_by?.[0]?.name;
                    const seasonCount = details.number_of_seasons;
                    const seasonStr = seasonCount
                      ? `${seasonCount} season${seasonCount > 1 ? "s" : ""}`
                      : null;

                    if (creator && seasonStr) {
                      extraInfo = ` — created by ${creator} — ${seasonStr}`;
                    } else if (creator) {
                      extraInfo = ` — created by ${creator}`;
                    } else if (seasonStr) {
                      extraInfo = ` — ${seasonStr}`;
                    }
                  }

                  let fullName = `${emoji} ${item.title || item.name}${year}${extraInfo}`;
                  if (fullName.length > 98) {
                    fullName = fullName.substring(0, 95) + "...";
                  }

                  return { name: fullName, value: `${item.id}|${item.media_type}` };
                } catch (err) {
                  const emoji = item.media_type === "movie" ? "🎬" : "📺";
                  const date =
                    item.release_date || item.first_air_date || "";
                  const year = date ? ` (${date.slice(0, 4)})` : "";
                  let basicName = `${emoji} ${item.title || item.name}${year}`;
                  if (basicName.length > 98) {
                    basicName = basicName.substring(0, 95) + "...";
                  }
                  return { name: basicName, value: `${item.id}|${item.media_type}` };
                }
              })
            );

            await interaction.respond(trendingChoices);
            return;
          } catch (e) {
            logger.error("Trending autocomplete error:", e);
            return interaction.respond([]);
          }
        }

        // Regular search autocomplete
        if (!focusedValue) return interaction.respond([]);

        try {
          const results = await tmdbApi.tmdbSearch(
            focusedValue,
            getTmdbApiKey()
          );
          const filtered = results
            .filter(
              (r) => r.media_type === "movie" || r.media_type === "tv"
            )
            .slice(0, 10);

          const detailedChoices = await Promise.all(
            filtered.map(async (item) => {
              try {
                const details = await tmdbApi.tmdbGetDetails(
                  item.id,
                  item.media_type,
                  getTmdbApiKey()
                );

                const emoji = item.media_type === "movie" ? "🎬" : "📺";
                const date =
                  item.release_date || item.first_air_date || "";
                const year = date ? ` (${date.slice(0, 4)})` : "";

                let extraInfo = "";
                if (item.media_type === "movie") {
                  const director = details.credits?.crew?.find(
                    (c) => c.job === "Director"
                  );
                  const directorName = director ? director.name : null;
                  const runtime = details.runtime;
                  const hours = runtime ? Math.floor(runtime / 60) : 0;
                  const minutes = runtime ? runtime % 60 : 0;
                  const runtimeStr = runtime
                    ? `${hours}h ${minutes}m`
                    : null;

                  if (directorName && runtimeStr) {
                    extraInfo = ` — directed by ${directorName} — runtime: ${runtimeStr}`;
                  } else if (directorName) {
                    extraInfo = ` — directed by ${directorName}`;
                  } else if (runtimeStr) {
                    extraInfo = ` — runtime: ${runtimeStr}`;
                  }
                } else {
                  const creator = details.created_by?.[0]?.name;
                  const seasonCount = details.number_of_seasons;
                  const seasonStr = seasonCount
                    ? `${seasonCount} season${seasonCount > 1 ? "s" : ""}`
                    : null;

                  if (creator && seasonStr) {
                    extraInfo = ` — created by ${creator} — ${seasonStr}`;
                  } else if (creator) {
                    extraInfo = ` — created by ${creator}`;
                  } else if (seasonStr) {
                    extraInfo = ` — ${seasonStr}`;
                  }
                }

                let fullName = `${emoji} ${item.title || item.name}${year}${extraInfo}`;
                if (fullName.length > 98) {
                  fullName = fullName.substring(0, 95) + "...";
                }

                return { name: fullName, value: `${item.id}|${item.media_type}` };
              } catch (err) {
                logger.debug(
                  `Failed to fetch details for ${item.id}:`,
                  err?.message
                );
                const emoji = item.media_type === "movie" ? "🎬" : "📺";
                const date =
                  item.release_date || item.first_air_date || "";
                const year = date ? ` (${date.slice(0, 4)})` : "";
                let basicName = `${emoji} ${item.title || item.name}${year}`;
                if (basicName.length > 98) {
                  basicName = basicName.substring(0, 95) + "...";
                }
                return { name: basicName, value: `${item.id}|${item.media_type}` };
              }
            })
          );

          await interaction.respond(detailedChoices);
        } catch (e) {
          logger.error("Autocomplete error:", e);
          return await interaction.respond([]);
        }
      }

      // Commands
      if (interaction.isCommand()) {
        if (!getSeerrUrl() || !getSeerrApiKey() || !getTmdbApiKey()) {
          return interaction.reply({
            content:
              "⚠️ This command is disabled because Seerr or TMDB configuration is missing.",
            flags: 64,
          });
        }
        const raw = getOptionStringRobust(interaction);
        if (interaction.commandName === "search")
          return handleSearchOrRequest(interaction, raw, "search");
        if (interaction.commandName === "request") {
          const tag = interaction.options.getString("tag");
          const quality = interaction.options.getString("quality");
          const server = interaction.options.getString("server");
          return handleSearchOrRequest(
            interaction,
            raw,
            "request",
            tag ? [tag] : [],
            { quality, server }
          );
        }
        if (interaction.commandName === "trending") {
          return handleSearchOrRequest(interaction, raw, "search");
        }
      }

      // ===== REQUEST BUTTON HANDLER =====
      // customId format: request_btn|tmdbId|mediaType|seasonsParam|tagsParam
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("request_btn|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const mediaType = parts[2] || "movie";
        const seasonsParam = parts[3] || "";
        const tagsParam = parts[4] || "";

        if (!tmdbId) {
          return interaction.reply({ content: "⚠️ ID invalid.", flags: 64 });
        }

        await interaction.deferUpdate();

        try {
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          const selectedSeasons = seasonsParam ? seasonsParam.split(",") : [];
          const selectedTagNames = tagsParam ? tagsParam.split(",") : [];
          let selectedTagIds = [];
          if (selectedTagNames.length > 0) {
            try {
              const allTags = await seerrApi.fetchTags(
                getSeerrUrl(),
                getSeerrApiKey()
              );

              const filteredTags = Array.isArray(allTags)
                ? mediaType === "movie"
                  ? allTags.filter((tag) => tag.type === "radarr")
                  : allTags.filter((tag) => tag.type === "sonarr")
                : [];

              selectedTagIds = selectedTagNames
                .map((tagName) => {
                  const tag = filteredTags.find(
                    (t) => (t.label || t.name) === tagName
                  );
                  return tag ? tag.id : null;
                })
                .filter((id) => id !== null);
            } catch (err) {
              logger.debug(
                "Failed to fetch tags for API call:",
                err?.message
              );
            }
          }

          const checkSeasons =
            mediaType === "movie"
              ? ["all"]
              : selectedSeasons.length > 0
                ? selectedSeasons
                : ["all"];
          const status = await seerrApi.checkMediaStatus(
            tmdbId,
            mediaType,
            checkSeasons,
            getSeerrUrl(),
            getSeerrApiKey()
          );

          if (status.exists && status.available) {
            await interaction.followUp({
              content:
                "✅ This content is already available in your library!",
              flags: 64,
            });
            return;
          }

          let seasonsToRequest =
            mediaType === "movie"
              ? undefined
              : selectedSeasons.length > 0
                ? selectedSeasons
                : ["all"];

          if (
            mediaType === "tv" &&
            (seasonsToRequest.includes("all") ||
              (Array.isArray(seasonsToRequest) &&
                seasonsToRequest[0] === "all"))
          ) {
            if (details.seasons) {
              const seasonNumbers = details.seasons
                .filter((s) => s.season_number > 0)
                .map((s) => s.season_number);
              if (seasonNumbers.length > 0) {
                seasonsToRequest = seasonNumbers;
                logger.info(
                  `[REQUEST BTN] Resolved 'all' seasons to explicit list: ${seasonsToRequest.join(", ")}`
                );
              }
            }
          }

          const { profileId, serverId } = parseQualityAndServerOptions(
            {},
            mediaType
          );

          await seerrApi.sendRequest({
            tmdbId,
            mediaType,
            seasons: seasonsToRequest,
            tags: selectedTagIds.length > 0 ? selectedTagIds : undefined,
            profileId,
            serverId,
            seerrUrl: getSeerrUrl(),
            apiKey: getSeerrApiKey(),
            discordUserId: interaction.user.id,
            userMappings: getUserMappings(),
            isAutoApproved: getSeerrAutoApprove(),
          });
          logger.info(
            `[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}. Auto-Approve: ${getSeerrAutoApprove()}`
          );

          if (process.env.NOTIFY_ON_AVAILABLE === "true") {
            const requestKey = `${tmdbId}-${mediaType}`;
            if (!pendingRequests.has(requestKey)) {
              pendingRequests.set(requestKey, new Set());
            }
            pendingRequests.get(requestKey).add(interaction.user.id);
            savePendingRequests();
          }

          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );
          const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

          const embed = buildNotificationEmbed(
            details,
            mediaType,
            imdbId,
            "success",
            omdb,
            tmdbId
          );

          const components = buildButtons(
            tmdbId,
            imdbId,
            true,
            mediaType,
            details,
            selectedSeasons.length > 0 ? selectedSeasons : ["all"],
            selectedTagNames
          );

          await interaction.editReply({ embeds: [embed], components });
        } catch (err) {
          logger.error("Button request error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ I could not send the request.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }

      // ===== SELECT SEASONS HANDLER =====
      // customId format: select_seasons|tmdbId|selectedTagsParam|menuIndex
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith("select_seasons|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const selectedTagsParam = parts[2] || "";
        const menuIndex = parts[3] ? parseInt(parts[3], 10) : undefined;
        const currentSelections = interaction.values;

        if (!tmdbId) {
          return interaction.reply({
            content: "⚠️ Invalid selection.",
            flags: 64,
          });
        }

        await interaction.deferUpdate();

        try {
          const selectedTags = selectedTagsParam
            ? selectedTagsParam.split(",")
            : [];

          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            "tv",
            getTmdbApiKey()
          );
          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            "tv",
            getTmdbApiKey()
          );

          let allSelectedSeasons = [];

          if (currentSelections.includes("all")) {
            allSelectedSeasons = ["all"];
          } else {
            const existingComponents =
              interaction.message.components || [];

            for (const row of existingComponents) {
              for (const component of row.components) {
                if (
                  component.customId &&
                  component.customId.startsWith("select_seasons|")
                ) {
                  const componentParts = component.customId.split("|");
                  const componentMenuIndex = componentParts[3]
                    ? parseInt(componentParts[3], 10)
                    : undefined;

                  if (
                    componentMenuIndex === menuIndex ||
                    (componentMenuIndex === undefined &&
                      menuIndex === undefined)
                  ) {
                    allSelectedSeasons.push(
                      ...currentSelections.filter((v) => v !== "all")
                    );
                  } else {
                    const existingSelections =
                      component.options
                        ?.filter((opt) => opt.default)
                        .map((opt) => opt.value)
                        .filter((v) => v !== "all") || [];
                    allSelectedSeasons.push(...existingSelections);
                  }
                }
              }
            }

            allSelectedSeasons = [...new Set(allSelectedSeasons)];
          }

          const components = buildButtons(
            tmdbId,
            imdbId,
            false,
            "tv",
            details,
            [],
            [],
            allSelectedSeasons,
            selectedTags
          );

          const seenSeasons = new Set();
          const uniqueSeasons = details.seasons.filter((s) => {
            if (s.season_number <= 0) return false;
            if (seenSeasons.has(s.season_number)) return false;
            seenSeasons.add(s.season_number);
            return true;
          });

          const tagsParam =
            selectedTags.length > 0 ? selectedTags.join(",") : "";
          const hasAllSeasons = allSelectedSeasons.includes("all");

          if (uniqueSeasons.length <= 24) {
            const seasonOptions = [
              { label: "All Seasons", value: "all" },
              ...uniqueSeasons.map((s) => ({
                label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                value: String(s.season_number),
              })),
            ];

            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_seasons|${tmdbId}|${tagsParam}`)
              .setPlaceholder("Select seasons to request...")
              .setMinValues(1)
              .setMaxValues(Math.min(25, seasonOptions.length))
              .addOptions(seasonOptions);

            components.push(new ActionRowBuilder().addComponents(selectMenu));
          } else {
            const SEASONS_PER_MENU = 24;
            const MAX_SEASON_MENUS = 4;

            const firstBatchSeasons = uniqueSeasons.slice(0, SEASONS_PER_MENU);
            const firstMenuOptions = [
              { label: "All Seasons", value: "all" },
              ...firstBatchSeasons.map((s) => ({
                label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                value: String(s.season_number),
              })),
            ];

            const firstMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|0`)
              .setPlaceholder(
                `Seasons 1-${firstBatchSeasons[firstBatchSeasons.length - 1].season_number}`
              )
              .setMinValues(0)
              .setMaxValues(firstMenuOptions.length)
              .addOptions(firstMenuOptions);

            components.push(
              new ActionRowBuilder().addComponents(firstMenu)
            );

            let menuIdx = 1;
            let offset = SEASONS_PER_MENU;

            while (
              offset < uniqueSeasons.length &&
              menuIdx < MAX_SEASON_MENUS
            ) {
              const batchSeasons = uniqueSeasons.slice(
                offset,
                offset + SEASONS_PER_MENU
              );

              if (batchSeasons.length > 0) {
                const batchOptions = batchSeasons.map((s) => ({
                  label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                  value: String(s.season_number),
                }));

                const batchMenu = new StringSelectMenuBuilder()
                  .setCustomId(
                    `select_seasons|${tmdbId}|${tagsParam}|${menuIdx}`
                  )
                  .setPlaceholder(
                    `Seasons ${batchSeasons[0].season_number}-${batchSeasons[batchSeasons.length - 1].season_number}`
                  )
                  .setMinValues(0)
                  .setMaxValues(batchOptions.length)
                  .addOptions(batchOptions);

                components.push(
                  new ActionRowBuilder().addComponents(batchMenu)
                );
              }

              offset += SEASONS_PER_MENU;
              menuIdx++;
            }
          }

          if (selectedTags.length === 0 && !hasAllSeasons) {
            try {
              const tags = await seerrApi.fetchTags(
                getSeerrUrl(),
                getSeerrApiKey()
              );

              if (tags && tags.length > 0) {
                const uniqueTags = [];
                const seenIds = new Set();

                for (const tag of tags) {
                  if (!seenIds.has(tag.id)) {
                    seenIds.add(tag.id);
                    uniqueTags.push(tag);
                  }
                }

                const tagOptions = uniqueTags.slice(0, 25).map((tag) => ({
                  label: tag.label || tag.name || `Tag ${tag.id}`,
                  value: tag.id.toString(),
                }));

                const tagMenu = new StringSelectMenuBuilder()
                  .setCustomId(
                    `select_tags|${tmdbId}|${allSelectedSeasons.join(",")}`
                  )
                  .setPlaceholder("Select tags (optional)")
                  .addOptions(tagOptions)
                  .setMinValues(0)
                  .setMaxValues(Math.min(5, tagOptions.length));

                const tagRow = new ActionRowBuilder().addComponents(tagMenu);
                components.push(tagRow);
              }
            } catch (err) {
              logger.debug(
                "Failed to fetch tags for season selector:",
                err?.message
              );
            }
          }

          await interaction.editReply({ components });
        } catch (err) {
          logger.error("Season selection error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ Error processing season selection.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }

      // Already-requested button
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("requested|")
      ) {
        try {
          await interaction.reply({
            content: "This item was already requested.",
            flags: 64,
          });
        } catch (replyErr) {
          logger.error(
            "Failed to send 'already requested' reply:",
            replyErr
          );
        }
      }

      // ===== DAILY RANDOM PICK REQUEST BUTTON HANDLER =====
      // customId format: request_random_tmdbId_mediaType
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("request_random_")
      ) {
        const parts = interaction.customId.split("_");
        const tmdbId = parseInt(parts[2], 10);
        const mediaType = parts[3] || "movie";

        if (!tmdbId) {
          return interaction.reply({
            content: "⚠️ Invalid media ID.",
            flags: 64,
          });
        }

        await interaction.deferUpdate();

        try {
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          const { profileId, serverId } = parseQualityAndServerOptions(
            {},
            mediaType
          );

          await seerrApi.sendRequest({
            tmdbId,
            mediaType,
            seasons: mediaType === "tv" ? ["all"] : undefined,
            profileId,
            serverId,
            seerrUrl: getSeerrUrl(),
            apiKey: getSeerrApiKey(),
            discordUserId: interaction.user.id,
            userMappings: getUserMappings(),
            isAutoApproved: getSeerrAutoApprove(),
          });

          if (process.env.NOTIFY_ON_AVAILABLE === "true") {
            const requestKey = `${tmdbId}-${mediaType}`;
            if (!pendingRequests.has(requestKey)) {
              pendingRequests.set(requestKey, new Set());
            }
            pendingRequests.get(requestKey).add(interaction.user.id);
            savePendingRequests();
          }

          await interaction.followUp({
            content: `✅ **${details.title || details.name}** has been requested!`,
            flags: 64,
          });
        } catch (err) {
          logger.error("Daily random pick request error:", err);
          await interaction.followUp({
            content: "⚠️ Error processing request.",
            flags: 64,
          });
        }
      }

      // ===== SELECT TAGS HANDLER =====
      // customId format: select_tags|tmdbId|selectedSeasonsParam
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith("select_tags|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const selectedSeasonsParam = parts[2] || "";
        const selectedSeasons = selectedSeasonsParam
          ? selectedSeasonsParam.split(",")
          : [];
        const selectedTagIds = interaction.values.map((v) => v.toString());

        if (!tmdbId) {
          return interaction.reply({
            content: "⚠️ Invalid request data.",
            flags: 64,
          });
        }

        await interaction.deferUpdate();

        try {
          const mediaType = selectedSeasons.length > 0 ? "tv" : "movie";

          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );
          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          let selectedTagNames = [];
          if (selectedTagIds.length > 0) {
            try {
              const allTags = await seerrApi.fetchTags(
                getSeerrUrl(),
                getSeerrApiKey()
              );

              const filteredTags = Array.isArray(allTags)
                ? mediaType === "movie"
                  ? allTags.filter((tag) => tag.type === "radarr")
                  : allTags.filter((tag) => tag.type === "sonarr")
                : [];

              selectedTagNames = selectedTagIds
                .map((tagId) => {
                  const tag = filteredTags.find(
                    (t) => t.id.toString() === tagId
                  );
                  return tag ? tag.label || tag.name : null;
                })
                .filter((name) => name !== null);
            } catch (err) {
              logger.debug("Failed to fetch tag names:", err?.message);
              selectedTagNames = selectedTagIds;
            }
          }

          const components = buildButtons(
            tmdbId,
            imdbId,
            false,
            mediaType,
            details,
            [],
            [],
            selectedSeasons,
            selectedTagNames
          );

          await interaction.editReply({ components });
        } catch (err) {
          logger.error("Tag selection error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ Error updating selection.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }
    } catch (outerErr) {
      logger.error("Interaction handler error:", outerErr);
    }
  });
}
