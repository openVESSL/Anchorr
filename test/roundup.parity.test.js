// Parity net for the Weekly Roundup digest, built from a fake Jellyfin /Items endpoint.
import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { createFakeDiscord } from "./helpers/discord.js";
import { startFakeServer } from "./helpers/http.js";

const NOW = Date.parse("2026-11-15T18:00:00Z");
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });

const { sendWeeklyRoundup } = await import("../bot/weeklyRoundup.js");
const { t: translate } = await import("../utils/i18n.js");

const LIB_MOVIES = "a".repeat(32);
const LIB_SHOWS = "b".repeat(32);
// Relative to the (fake) clock at request time, so items stay "recent" after ticking.
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

const items = () => ({
  [LIB_MOVIES]: [
    { Id: "m1", Type: "Movie", Name: "Dune: Part Two", ProductionYear: 2024, DateCreated: daysAgo(1) },
    { Id: "m2", Type: "Movie", Name: "Arrival", ProductionYear: 2016, DateCreated: daysAgo(3) },
  ],
  [LIB_SHOWS]: [
    { Id: "e1", Type: "Episode", Name: "Pilot", SeriesId: "s1", SeriesName: "Severance", ParentIndexNumber: 2, IndexNumber: 1, DateCreated: daysAgo(2) },
    { Id: "e2", Type: "Episode", Name: "Ep 2", SeriesId: "s1", SeriesName: "Severance", ParentIndexNumber: 2, IndexNumber: 2, DateCreated: daysAgo(2) },
    { Id: "e2b", Type: "Episode", Name: "Ep 2", SeriesId: "s1", SeriesName: "Severance", ParentIndexNumber: 2, IndexNumber: 2, DateCreated: daysAgo(1) },
    { Id: "s2", Type: "Series", Name: "Shogun", ProductionYear: 2024, DateCreated: daysAgo(4) },
  ],
});

let jellyfin;
before(async () => {
  jellyfin = await startFakeServer({
    "GET /Items": ({ url }) => {
      const list = items()[url.searchParams.get("ParentId")] || [];
      return { Items: list, TotalRecordCount: list.length };
    },
    "GET /Library/VirtualFolders": () => [
      { ItemId: LIB_MOVIES, Name: "Movies", CollectionType: "movies" },
      { ItemId: LIB_SHOWS, Name: "Shows", CollectionType: "tvshows" },
    ],
  });
  applyConfig({
    LANGUAGE: "en",
    JELLYFIN_BASE_URL: jellyfin.url,
    JELLYFIN_API_KEY: "test-key",
    JELLYFIN_NOTIFICATION_LIBRARIES: {
      [LIB_MOVIES]: { channel: "c1", isAnime: false },
      [LIB_SHOWS]: { channel: "c2", isAnime: false },
    },
  });
});
after(() => jellyfin.close());

// Tests run in order and share the install date recorded by the first one.

test("first run after install: nothing older than the install is posted, and the test button says why", async () => {
  const discord = createFakeDiscord();
  await assert.rejects(
    sendWeeklyRoundup(discord.client, "chan-roundup", new Date(), { test: true }),
    { message: translate("roundup.diag_all_pre_install", { count: 6 }) }
  );
  assert.equal(await sendWeeklyRoundup(discord.client, "chan-roundup", new Date()), false);
  assert.equal(discord.sent.length, 0);
});

test("a week later: posts one digest grouped per library, re-imported episodes counted once", async () => {
  mock.timers.tick(8 * 86_400_000);
  const discord = createFakeDiscord();
  assert.equal(await sendWeeklyRoundup(discord.client, "chan-roundup", new Date()), true);

  assert.equal(discord.sent.length, 1);
  const [post] = discord.sent;
  assert.equal(post.channelId, "chan-roundup");
  assert.equal(post.content, undefined, "no role mention unless configured");

  const [embed] = post.embeds;
  const link = (id) => `${jellyfin.url}/web/index.html#!/details?id=${id}`;
  assert.equal(embed.title, "📦 New this week");
  assert.equal(embed.description, "November 16, 2026 – November 23, 2026");
  assert.equal(embed.color, 0xcba6f7);
  assert.deepEqual(
    embed.fields.map((f) => [f.name, f.value]),
    [
      ["Movies", "​"],
      ["Movies", `🎬 [**Dune: Part Two** (2024)](${link("m1")})\n🎬 [**Arrival** (2016)](${link("m2")})`],
      ["Shows", "​"],
      ["Series", `📺 [**Severance**](${link("s1")}) — Season 2 (2 episodes)\n📺 [**Shogun**](${link("s2")})`],
    ]
  );
  assert.equal(embed.footer.text, "4 new items");
});

test("a configured role is mentioned on scheduled posts but not on test posts", async (t) => {
  t.after(applyConfig({ WEEKLY_ROUNDUP_ROLE_ID: "123456789012345678" }));
  const discord = createFakeDiscord();

  await sendWeeklyRoundup(discord.client, "chan-roundup", new Date());
  assert.equal(discord.sent[0].content, "<@&123456789012345678>");
  assert.deepEqual(discord.sent[0].allowedMentions, { parse: ["roles"] });

  await sendWeeklyRoundup(discord.client, "chan-roundup", new Date(), { test: true });
  assert.equal(discord.sent[1].content, undefined);
});
