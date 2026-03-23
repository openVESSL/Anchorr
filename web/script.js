// --- i18n System ---
let currentTranslations = {};
let currentLanguage = 'en';

function isSafeAvatarUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

async function loadTranslations(language) {
  try {
    const response = await fetch(`/locales/${language}.json`);
    if (!response.ok) {
      console.warn(`Failed to load ${language} translations, falling back to English`);
      const fallbackResponse = await fetch('/locales/en.json');
      return await fallbackResponse.json();
    }
    return await response.json();
  } catch (error) {
    console.error('Error loading translations:', error);
    // Return minimal fallback
    return {
      common: { loading: 'Loading...' },
      auth: { login: 'Login' },
      config: { title: 'Configuration' }
    };
  }
}

function sanitizeTranslationHtml(str) {
  if (typeof str !== "string") return str;
  // DOM-based allowlist sanitizer: only permit safe inline elements.
  // Regex-based HTML stripping is inherently bypass-prone; parsing via the
  // browser's own HTML parser is the only reliable approach.
  const div = document.createElement("div");
  div.innerHTML = str;
  div.querySelectorAll("*").forEach((el) => {
    const allowed = ["STRONG", "EM", "CODE", "BR", "A", "B", "I"];
    if (!allowed.includes(el.tagName)) {
      el.replaceWith(document.createTextNode(el.textContent));
      return;
    }
    // Strip all attributes; re-allow only safe href on <a>
    for (const attr of [...el.attributes]) {
      if (el.tagName === "A" && attr.name === "href") {
        if (/^javascript:/i.test(attr.value.trim())) el.removeAttribute("href");
      } else {
        el.removeAttribute(attr.name);
      }
    }
  });
  return div.innerHTML;
}

function updateUITranslations() {
  // Update all elements with data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const translation = getNestedTranslation(key);
    if (translation) {
      // Check if element needs attribute translation
      const attrName = element.getAttribute('data-i18n-attr');
      if (attrName) {
        element.setAttribute(attrName, translation);
      } else {
        // Sanitize before injecting — translations may contain safe markup (strong, code)
        // but must never execute scripts or event handlers
        element.innerHTML = sanitizeTranslationHtml(translation);
      }
    }
  });
}

function getNestedTranslation(key) {
  const result = key.split('.').reduce((obj, k) => obj && obj[k], currentTranslations);
  return result || key; // Fallback to key if translation not found
}

// Short alias for getNestedTranslation
function t(key) {
  if (!key || typeof key !== 'string') {
    console.warn('Invalid translation key:', key);
    return key || '';
  }
  return getNestedTranslation(key);
}

async function switchLanguage(language) {
  currentLanguage = language;
  currentTranslations = await loadTranslations(language);
  updateUITranslations();
  
  // Save language preference
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ LANGUAGE: language })
    });
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
}

function setupAuthLanguageHandler() {
  const authLanguageSelect = document.getElementById('auth-language');
  if (authLanguageSelect) {
    authLanguageSelect.addEventListener('change', async (e) => {
      await switchLanguage(e.target.value);
    });
  }
}

function setupLanguageChangeHandler() {
  // Handle app-language selector in Miscellaneous section
  const appLanguageSelect = document.getElementById('app-language');
  if (appLanguageSelect) {
    appLanguageSelect.addEventListener('change', async (e) => {
      await switchLanguage(e.target.value);
      // Sync with auth-language selector if visible
      const authLanguageSelect = document.getElementById('auth-language');
      if (authLanguageSelect) {
        authLanguageSelect.value = e.target.value;
      }
    });
  }
}

// Get available languages from locale files
async function getAvailableLanguages() {
  try {
    const response = await fetch('/api/languages');
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn('Failed to load available languages, using fallback');
  }
  
  // Fallback to hardcoded languages if API fails
  return [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'sv', name: 'Svenska' }
  ];
}

// Populate language selectors dynamically
async function populateLanguageSelectors() {
  const languages = await getAvailableLanguages();
  const selectors = document.querySelectorAll('#auth-language, #app-language');
  
  selectors.forEach(select => {
    if (!select) return;
    
    // Clear existing options
    select.innerHTML = '';
    
    // Add language options
    languages.forEach(lang => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.name;
      select.appendChild(option);
    });
    
    // Set current language
    select.value = currentLanguage;
  });
}

// Initialize i18n system
async function initializeI18n() {
  // Try to get saved language preference
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    currentLanguage = config.LANGUAGE || 'en';
  } catch (error) {
    console.warn('Could not load saved language, using default');
    currentLanguage = 'en';
  }
  
  // Populate language selectors
  await populateLanguageSelectors();
  
  // Load translations and update UI
  currentTranslations = await loadTranslations(currentLanguage);
  updateUITranslations();
  
  // Setup change handlers
  setupAuthLanguageHandler();
  setupLanguageChangeHandler();
}

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize i18n first
  await initializeI18n();

  // Fetch and display app version
  fetch("/api/health")
    .then((r) => r.json())
    .then((data) => {
      if (data.version) {
        const v = `v${data.version}`;
        const footerEl = document.getElementById("footer-version");
        const aboutEl = document.getElementById("about-version");
        if (footerEl) footerEl.textContent = v;
        if (aboutEl) aboutEl.textContent = v;
      }
    })
    .catch(() => {});
  const form = document.getElementById("config-form");
  const botControlBtn = document.getElementById("bot-control-btn");
  const botControlText = document.getElementById("bot-control-text");
  const botControlIcon = botControlBtn.querySelector("i");
  const webhookSection = document.getElementById("webhook-section");
  const webhookUrlElement = document.getElementById("webhook-url");
  const copyWebhookBtn = document.getElementById("copy-webhook-btn");
  const navItems = document.querySelectorAll(
    ".nav-item, .about-button, .about-link"
  );
  const testSeerrBtn = document.getElementById("test-seerr-btn");
  const testSeerrStatus = document.getElementById(
    "test-seerr-status"
  );
  const testJellyfinBtn = document.getElementById("test-jellyfin-btn");
  const testJellyfinStatus = document.getElementById("test-jellyfin-status");
  // Create toast element dynamically
  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast";
  document.body.appendChild(toast);

  // Global status polling interval to prevent duplicates
  let statusPollingInterval = null;

  // --- Functions ---

  function startStatusPolling() {
    // Only start if not already running
    if (statusPollingInterval !== null) return;

    // Immediately fetch status
    fetchStatus();

    // Then set up polling every 30 seconds (increased from 10s to reduce load)
    statusPollingInterval = setInterval(fetchStatus, 30000);
  }

  function stopStatusPolling() {
    if (statusPollingInterval !== null) {
      clearInterval(statusPollingInterval);
      statusPollingInterval = null;
    }
  }

  function showToast(message, duration = 3000) {
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, duration);
  }

  async function fetchConfig() {
    try {
      const response = await fetch("/api/config");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const config = await response.json();
      for (const key in config) {
        const input = document.getElementById(key);
        if (!input) continue;
        if (input.type === "checkbox") {
          const val = String(config[key]).trim().toLowerCase();
          input.checked = val === "true" || val === "1" || val === "yes";
        } else {
          // Special handling for library configuration - must stringify object
          if (key === "JELLYFIN_NOTIFICATION_LIBRARIES") {
            // Special handling for library configuration - must stringify object
            const value = config[key];
            if (typeof value === "object" && value !== null) {
              input.value = JSON.stringify(value);
            } else if (typeof value === "string") {
              input.value = value;
            } else {
              input.value = "{}";
            }
          } else if (input.tagName === "SELECT") {
            // For select elements, save the value to restore later (after options are loaded)
            input.dataset.savedValue = config[key];
            // Also try setting it directly in case options are already there (unlikely but safe)
            input.value = config[key];
          } else {
            input.value = config[key];
          }
        }
      }
      
      // Sync app-language selector with LANGUAGE config value
      if (config.LANGUAGE) {
        const appLanguageSelect = document.getElementById('app-language');
        const authLanguageSelect = document.getElementById('auth-language');
        if (appLanguageSelect) {
          appLanguageSelect.value = config.LANGUAGE;
        }
        if (authLanguageSelect) {
          authLanguageSelect.value = config.LANGUAGE;
        }
        // Update global currentLanguage
        currentLanguage = config.LANGUAGE;
      }
      
      // Initialize episodes/seasons notify values
      const episodesNotifyInput = document.getElementById("JELLYFIN_NOTIFY_EPISODES");
      const seasonsNotifyInput = document.getElementById("JELLYFIN_NOTIFY_SEASONS");
      
      if (episodesNotifyInput) {
        // Set empty string if not configured, "true" if enabled
        episodesNotifyInput.value = config.JELLYFIN_NOTIFY_EPISODES === "true" ? "true" : "";
      }
      if (seasonsNotifyInput) {
        seasonsNotifyInput.value = config.JELLYFIN_NOTIFY_SEASONS === "true" ? "true" : "";
      }
      
      updateWebhookUrl();
    } catch (error) {
      showToast("Error fetching configuration.");
    }
  }

  async function fetchStatus() {
    try {
      const response = await fetch("/api/status");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const status = await response.json();
      updateStatusIndicator(status.isBotRunning, status.botUsername);
    } catch (error) {
      updateStatusIndicator(false);
    }
  }

  function updateStatusIndicator(isRunning, username = null) {
    botControlBtn.disabled = false;
    if (isRunning) {
      botControlBtn.classList.remove("btn-success");
      botControlBtn.classList.add("btn-danger");
      botControlIcon.className = "bi bi-pause-fill";
      botControlText.textContent = "Stop Bot";
      botControlBtn.dataset.action = "stop";
    } else {
      botControlBtn.classList.remove("btn-danger");
      botControlBtn.classList.add("btn-success");
      botControlIcon.className = "bi bi-play-fill";
      botControlText.textContent = "Start Bot";
      botControlBtn.dataset.action = "start";
    }
  }

  function updateWebhookUrl(port = null) {
    // If no port provided, use the current window port (which is the actual server port)
    const actualPort = port || window.location.port || 8282;
    // Use `window.location.hostname` which is more reliable than guessing the host IP.
    // This works well for localhost and for accessing via a local network IP.
    const host = window.location.hostname;
    webhookUrlElement.textContent = `http://${host}:${actualPort}/jellyfin-webhook`;
  }

  // --- Auth Logic ---
  const mainHero = document.getElementById("main-hero");
  const authContainer = document.getElementById("auth-container-wrapper");
  const heroTextAuth = document.getElementById("hero-text-auth");
  const heroTextDashboard = document.getElementById("hero-text-dashboard");
  const dashboardContent = document.getElementById("dashboard-content");

  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const authError = document.getElementById("auth-error");
  const showRegisterLink = document.getElementById("show-register");
  const showLoginLink = document.getElementById("show-login");
  const logoutBtn = document.getElementById("logout-btn");

  async function checkAuth() {
    try {
      const response = await fetch("/api/auth/check");
      const data = await response.json();

      if (data.isAuthenticated) {
        // User is authenticated, remove auth-mode to show header/footer
        document.body.classList.remove("auth-mode");
        showDashboard(false); // Show dashboard immediately without animation
        logoutBtn.classList.remove("hidden");
        fetchConfig().then(() => {
          loadDiscordGuilds();
          checkAndLoadMappingsTab();
        });
        startStatusPolling();
      } else {
        showAuth(data.hasUsers);
      }
    } catch (error) {
      showAuth(true); // Default to showing login if check fails
    }
  }

  function showAuth(hasUsers) {
    document.body.classList.add("auth-mode"); // Hide header/footer
    mainHero.classList.add("full-screen");
    authContainer.classList.remove("hidden");
    authContainer.style.display = "block";
    heroTextAuth.style.display = "block";
    heroTextDashboard.style.display = "none";
    dashboardContent.style.display = "none";
    dashboardContent.classList.remove("visible");

    if (!hasUsers) {
      // No users exist, show register form
      loginForm.style.display = "none";
      registerForm.style.display = "block";
    } else {
      // Users exist, show login form
      loginForm.style.display = "block";
      registerForm.style.display = "none";
    }
  }

  function showDashboard(animate = true) {
    const setupContainer = document.querySelector("#config-section .container");
    const navbar = document.querySelector(".navbar");

    if (animate) {
      // Enable transition for animation
      mainHero.classList.add("animating");

      // 1. Fade out auth container AND hero text
      authContainer.classList.add("hidden");
      heroTextAuth.style.opacity = "0"; // Fade out text
      heroTextAuth.style.transition = "opacity 0.5s ease"; // Ensure transition

      // 2. Wait for auth fade out (500ms)
      setTimeout(() => {
        authContainer.style.display = "none"; // Remove from flow
        heroTextAuth.style.display = "none"; // Remove text from flow

        // 3. Start shrinking hero
        mainHero.classList.remove("full-screen");

        // Show dashboard text BUT hide it initially for animation
        heroTextDashboard.style.display = "block";
        heroTextDashboard.classList.add("dashboard-text-animate"); // Prepare for animation

        // Show dashboard content wrapper immediately (but setup container is hidden via class)
        dashboardContent.style.display = "block";
        if (setupContainer) {
          setupContainer.classList.add("setup-container-animate");
        }

        // 4. Wait for hero shrink to complete (1200ms)
        setTimeout(() => {
          // 5. Set hero to final state (min-height: auto)
          mainHero.classList.add("final-state");
          mainHero.classList.remove("animating");

          // 6. Prepare Navbar for slide-down
          // First, ensure it's hidden via transform (while still display:none from auth-mode)
          if (navbar) {
            navbar.classList.add("navbar-hidden");
          }

          // Remove auth-mode to make navbar display:block (but still hidden via transform)
          document.body.classList.remove("auth-mode");

          // Force reflow to ensure browser registers the transform: -100% state
          if (navbar) void navbar.offsetWidth;

          // 7. Animate Navbar Slide Down & Content Fade In simultaneously
          requestAnimationFrame(() => {
            // Slide down navbar
            if (navbar) {
              navbar.classList.remove("navbar-hidden");
            }

            // Fade in content
            if (setupContainer) {
              setupContainer.classList.add("visible");
            }

            // Animate Dashboard Title
            heroTextDashboard.classList.add("visible");
          });
        }, 1200); // Match CSS transition time for hero
      }, 500); // Match CSS transition time for auth container
    } else {
      // Instant switch (No animation)
      document.body.classList.remove("auth-mode");
      mainHero.classList.remove("animating");
      mainHero.classList.add("final-state"); // Ensure final state
      authContainer.style.display = "none";
      mainHero.classList.remove("full-screen");
      heroTextAuth.style.display = "none";
      heroTextDashboard.style.display = "block";
      dashboardContent.style.display = "block";

      // Ensure setup container is visible without animation class
      if (setupContainer) {
        setupContainer.classList.remove("setup-container-animate");
        setupContainer.classList.add("visible");
        setupContainer.style.opacity = "1";
        setupContainer.style.transform = "none";
      }

      // Ensure dashboard text is visible without animation class
      heroTextDashboard.classList.remove("dashboard-text-animate");
      heroTextDashboard.classList.add("visible"); // Or just ensure opacity 1
      heroTextDashboard.style.opacity = "1";
      heroTextDashboard.style.transform = "none";
    }
  }

  // Auth Event Listeners
  if (showRegisterLink) {
    showRegisterLink.addEventListener("click", (e) => {
      e.preventDefault();
      loginForm.style.display = "none";
      registerForm.style.display = "block";
      authError.textContent = "";
    });
  }

  if (showLoginLink) {
    showLoginLink.addEventListener("click", (e) => {
      e.preventDefault();
      registerForm.style.display = "none";
      loginForm.style.display = "block";
      authError.textContent = "";
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("login-username").value;
      const password = document.getElementById("login-password").value;

      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();

        if (data.success) {
          showDashboard(true);
          logoutBtn.classList.remove("hidden");
          fetchConfig().then(() => {
            loadDiscordGuilds();
            checkAndLoadMappingsTab();
          });
          startStatusPolling();
        } else {
          authError.textContent = data.message;
        }
      } catch (error) {
        authError.textContent = "Login failed. Please try again.";
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("register-username").value;
      const password = document.getElementById("register-password").value;

      try {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();

        if (data.success) {
          showDashboard(true);
          logoutBtn.classList.remove("hidden");
          fetchConfig().then(() => {
            loadDiscordGuilds();
            checkAndLoadMappingsTab();
          });
          startStatusPolling();
        } else {
          authError.textContent = data.message;
        }
      } catch (error) {
        authError.textContent = "Registration failed. Please try again.";
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        stopStatusPolling();
        await fetch("/api/auth/logout", { method: "POST" });
        location.reload();
      } catch (error) {
        // Logout error handling
      }
    });
  }

  // --- Event Listeners ---

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(form);

    // Filter out empty keys
    const filteredEntries = Array.from(formData.entries()).filter(
      ([key, value]) => {
        const isValid = key.trim() !== "";
        return isValid;
      }
    );

    const config = Object.fromEntries(filteredEntries);

    // Add language setting from app-language selector
    const appLanguageSelect = document.getElementById('app-language');
    if (appLanguageSelect && appLanguageSelect.value) {
      config.LANGUAGE = appLanguageSelect.value;
    }

    // Explicitly capture checkbox values as "true"/"false" (except role checkboxes)
    document
      .querySelectorAll(
        'input[type="checkbox"]:not([name="ROLE_ALLOWLIST"]):not([name="ROLE_BLOCKLIST"])'
      )
      .forEach((cb) => {
        if (cb.id && cb.id.trim() !== "") {
          config[cb.id] = cb.checked ? "true" : "false";
        }
      });

    // Handle role allowlist/blocklist as arrays
    const allowlistRoles = Array.from(
      document.querySelectorAll('input[name="ROLE_ALLOWLIST"]:checked')
    ).map((cb) => cb.value);
    const blocklistRoles = Array.from(
      document.querySelectorAll('input[name="ROLE_BLOCKLIST"]:checked')
    ).map((cb) => cb.value);

    config.ROLE_ALLOWLIST = allowlistRoles;
    config.ROLE_BLOCKLIST = blocklistRoles;

    // Handle Jellyfin notification libraries (can be array or object)
    try {
      const libConfigString = config.JELLYFIN_NOTIFICATION_LIBRARIES;
      config.JELLYFIN_NOTIFICATION_LIBRARIES = libConfigString
        ? JSON.parse(libConfigString)
        : {};
    } catch (e) {
      config.JELLYFIN_NOTIFICATION_LIBRARIES = {};
    }

    // Check if saving would trigger bot auto-start
    try {
      const autostartResponse = await fetch("/api/check-autostart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const autostartData = await autostartResponse.json();

      if (autostartData.wouldAutoStart) {
        // Show confirmation modal
        showBotAutostartModal(config);
      } else {
        // Save normally without modal
        await saveConfig(config);
      }
    } catch (error) {
      // If check fails, save normally
      await saveConfig(config);
    }
  });

  // Function to show bot auto-start confirmation modal
  function showBotAutostartModal(config) {
    const modal = document.getElementById("bot-autostart-modal");
    const yesBtn = document.getElementById("modal-start-yes");
    const noBtn = document.getElementById("modal-start-no");

    // Show modal
    modal.style.display = "flex";

    // Handle Yes button (start bot)
    const handleYes = async () => {
      modal.style.display = "none";
      config.startBot = true;
      await saveConfig(config);
      
      // Wait a moment for the bot to start, then reload Discord data
      setTimeout(async () => {
        await loadDiscordGuilds();
        // If a guild is already selected, reload its channels
        const guildSelect = document.getElementById("GUILD_ID");
        if (guildSelect && guildSelect.value) {
          await loadDiscordChannels(guildSelect.value);
        }
      }, 2000);
      
      cleanupModal();
    };

    // Handle No button (save only)
    const handleNo = async () => {
      modal.style.display = "none";
      config.startBot = false;
      await saveConfig(config);
      cleanupModal();
    };

    // Close modal on backdrop click
    const handleBackdrop = (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
        cleanupModal();
      }
    };

    // Close modal on Escape key
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        modal.style.display = "none";
        cleanupModal();
      }
    };

    // Cleanup function to remove event listeners
    const cleanupModal = () => {
      yesBtn.removeEventListener("click", handleYes);
      noBtn.removeEventListener("click", handleNo);
      modal.removeEventListener("click", handleBackdrop);
      document.removeEventListener("keydown", handleEscape);
    };

    // Add event listeners
    yesBtn.addEventListener("click", handleYes);
    noBtn.addEventListener("click", handleNo);
    modal.addEventListener("click", handleBackdrop);
    document.addEventListener("keydown", handleEscape);
  }

  // Function to save config
  async function saveConfig(config) {
    try {
      const response = await fetch("/api/save-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) {
        const result = await response.json();
        const errorMsg =
          result.errors?.map((e) => `${e.field}: ${e.message}`).join(", ") ||
          result.message;
        showToast(`Error: ${errorMsg}`);
      } else {
        const result = await response.json();
        showToast(result.message);
      }
    } catch (error) {
      showToast("Error saving configuration.");
    }
  }

  botControlBtn.addEventListener("click", async () => {
    const action = botControlBtn.dataset.action;
    if (!action) return;

    botControlBtn.disabled = true;
    const originalText = botControlText.textContent;
    botControlText.textContent = "Processing...";

    try {
      const response = await fetch(`/api/${action}-bot`, { method: "POST" });
      if (!response.ok) {
        const result = await response.json();
        showToast(`Error: ${result.message}`);
        botControlText.textContent = originalText; // Restore text on failure
        botControlBtn.disabled = false;
      } else {
        const result = await response.json();
        showToast(result.message);
        setTimeout(() => {
          fetchStatus();
          // Also update logs page button if visible
          if (logsSection.style.display !== "none") {
            updateBotControlButtonLogs();
          }
          // If we just started the bot, refresh the guilds list
          if (action === "start") {
            loadDiscordGuilds();
          }
        }, 1000); // Fetch status after a short delay to get the new state
      }
    } catch (error) {
      showToast(`Failed to ${action} bot.`);
      botControlText.textContent = originalText; // Restore text on failure
      botControlBtn.disabled = false;
    }
  });

  // Handle navigation between config panes
  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();

      const targetId = item.getAttribute("data-target");

      // Handle About page separately
      if (targetId === "about") {
        // Hide dashboard layout
        document.querySelector(".dashboard-layout").style.display = "none";
        // Show about page
        document.getElementById("about-page").style.display = "block";
        // Update dashboard title to "Back to Configuration"
        const dashboardTitle = document.getElementById("dashboard-title");
        dashboardTitle.innerHTML =
          '<i class="bi bi-arrow-left"></i> Back to Configuration';
        dashboardTitle.style.cursor = "pointer";
        dashboardTitle.classList.add("back-link");
        return;
      }

      // Update active nav item
      navItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");

      // Show the correct pane
      document.querySelectorAll(".config-pane").forEach((pane) => {
        pane.classList.remove("active");
      });
      document
        .getElementById(`config-pane-${targetId}`)
        .classList.add("active");

      // Load data when mappings tab is opened
      if (targetId === "mappings") {
        // Only load mappings (with saved metadata), not members/users yet
        loadMappings();
      }

      // Load roles when role mapping tab is opened
      if (targetId === "roles") {
        loadRoles();
      }
    });
  });

  // Handle "Back to Configuration" click
  document.getElementById("dashboard-title").addEventListener("click", () => {
    const dashboardTitle = document.getElementById("dashboard-title");

    // Only handle if it's in "back" mode
    if (dashboardTitle.classList.contains("back-link")) {
      // Show dashboard layout
      document.querySelector(".dashboard-layout").style.display = "grid";
      // Hide about page
      document.getElementById("about-page").style.display = "none";
      // Reset dashboard title
      dashboardTitle.innerHTML = "Configuration";
      dashboardTitle.style.cursor = "default";
      dashboardTitle.classList.remove("back-link");

      // Reactivate the first nav item (Discord)
      navItems.forEach((i) => i.classList.remove("active"));
      document
        .querySelector('.nav-item[data-target="discord"]')
        .classList.add("active");

      // Show the Discord pane
      document.querySelectorAll(".config-pane").forEach((pane) => {
        pane.classList.remove("active");
      });
      document.getElementById("config-pane-discord").classList.add("active");
    }
  });

  // Initialize webhook URL on page load with actual server port
  updateWebhookUrl();

  // Populate webhook secret input on page load
  (async () => {
    try {
      const response = await fetch("/api/webhook-secret");
      if (response.ok) {
        const data = await response.json();
        const input = document.getElementById("WEBHOOK_SECRET");
        if (input && data.secret) input.value = data.secret;
      }
    } catch (_) {}
  })();

  // Copy webhook secret (reads from the already-populated input field)
  document.getElementById("copy-webhook-secret-btn").addEventListener("click", () => {
    const textToCopy = document.getElementById("WEBHOOK_SECRET")?.value || "";
    if (!textToCopy) {
      showToast("No webhook secret configured.");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy)
        .then(() => showToast("Webhook secret copied to clipboard!"))
        .catch(() => fallbackCopyTextToClipboard(textToCopy));
    } else {
      fallbackCopyTextToClipboard(textToCopy);
    }
  });

  // Copy webhook URL
  copyWebhookBtn.addEventListener("click", () => {
    const textToCopy = webhookUrlElement.textContent;

    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          showToast("Webhook URL copied to clipboard!");
        })
        .catch(() => {
          // Fallback if clipboard API fails
          fallbackCopyTextToClipboard(textToCopy);
        });
    } else {
      // Fallback for older browsers
      fallbackCopyTextToClipboard(textToCopy);
    }
  });

  // Fallback copy function for older browsers
  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.width = "2em";
    textArea.style.height = "2em";
    textArea.style.padding = "0";
    textArea.style.border = "none";
    textArea.style.outline = "none";
    textArea.style.boxShadow = "none";
    textArea.style.background = "transparent";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand("copy");
      if (successful) {
        showToast("Webhook URL copied to clipboard!");
      } else {
        showToast("Failed to copy URL. Please copy manually.");
      }
    } catch (err) {
      showToast("Failed to copy URL. Please copy manually.");
    }

    document.body.removeChild(textArea);
  }

  // Test Seerr Connection
  if (testSeerrBtn) {
    testSeerrBtn.addEventListener("click", async () => {
      const url = document.getElementById("SEERR_URL").value;
      const apiKey = document.getElementById("SEERR_API_KEY").value;

      testSeerrBtn.disabled = true;
      testSeerrStatus.textContent = "Testing...";
      testSeerrStatus.style.color = "var(--text)";

      try {
        const response = await fetch("/api/test-seerr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, apiKey }),
        });

        if (response.ok) {
          const result = await response.json();
          testSeerrStatus.textContent = result.message;
          testSeerrStatus.style.color = "var(--green)";
        } else {
          const result = await response.json();
          throw new Error(result.message);
        }
      } catch (error) {
        testSeerrStatus.textContent =
          error.message || "Connection failed.";
        testSeerrStatus.style.color = "#f38ba8"; // Red
      } finally {
        testSeerrBtn.disabled = false;
      }
    });
  }

  // Load Quality Profiles and Servers
  const loadSeerrOptionsBtn = document.getElementById("load-seerr-options-btn");
  const loadSeerrOptionsStatus = document.getElementById("load-seerr-options-status");
  
  if (loadSeerrOptionsBtn) {
    loadSeerrOptionsBtn.addEventListener("click", async () => {
      const url = document.getElementById("SEERR_URL").value;
      const apiKey = document.getElementById("SEERR_API_KEY").value;

      if (!url || !apiKey) {
        loadSeerrOptionsStatus.textContent = "Enter URL and API Key first";
        loadSeerrOptionsStatus.style.color = "#f38ba8";
        return;
      }

      loadSeerrOptionsBtn.disabled = true;
      loadSeerrOptionsStatus.textContent = "Loading...";
      loadSeerrOptionsStatus.style.color = "var(--text)";

      try {
        // Fetch quality profiles
        const profilesResponse = await fetch("/api/seerr/quality-profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, apiKey }),
        });

        if (!profilesResponse.ok) {
          throw new Error("Failed to fetch quality profiles");
        }
        const profilesResult = await profilesResponse.json();

        // Fetch servers
        const serversResponse = await fetch("/api/seerr/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, apiKey }),
        });

        if (!serversResponse.ok) {
          throw new Error("Failed to fetch servers");
        }
        const serversResult = await serversResponse.json();

        // Validate API responses
        if (!Array.isArray(profilesResult.profiles)) {
          throw new Error("Invalid quality profiles response");
        }
        if (!Array.isArray(serversResult.servers)) {
          throw new Error("Invalid servers response");
        }

        // Get current saved values
        const movieQualitySelect = document.getElementById("DEFAULT_QUALITY_PROFILE_MOVIE");
        const tvQualitySelect = document.getElementById("DEFAULT_QUALITY_PROFILE_TV");
        const movieServerSelect = document.getElementById("DEFAULT_SERVER_MOVIE");
        const tvServerSelect = document.getElementById("DEFAULT_SERVER_TV");

        const savedMovieQuality = movieQualitySelect.dataset.savedValue || movieQualitySelect.value;
        const savedTvQuality = tvQualitySelect.dataset.savedValue || tvQualitySelect.value;
        const savedMovieServer = movieServerSelect.dataset.savedValue || movieServerSelect.value;
        const savedTvServer = tvServerSelect.dataset.savedValue || tvServerSelect.value;

        // Movie quality profiles (Radarr)
        movieQualitySelect.innerHTML = '<option value="">Use Seerr default</option>';
        const radarrProfiles = profilesResult.profiles.filter(p => p.type === "radarr");
        radarrProfiles.forEach(profile => {
          const option = document.createElement("option");
          option.value = `${profile.id}|${profile.serverId}`;
          option.textContent = `${profile.name} (${profile.serverName})`;
          movieQualitySelect.appendChild(option);
        });
        if (savedMovieQuality) movieQualitySelect.value = savedMovieQuality;

        // TV quality profiles (Sonarr)
        tvQualitySelect.innerHTML = '<option value="">Use Seerr default</option>';
        const sonarrProfiles = profilesResult.profiles.filter(p => p.type === "sonarr");
        sonarrProfiles.forEach(profile => {
          const option = document.createElement("option");
          option.value = `${profile.id}|${profile.serverId}`;
          option.textContent = `${profile.name} (${profile.serverName})`;
          tvQualitySelect.appendChild(option);
        });
        if (savedTvQuality) tvQualitySelect.value = savedTvQuality;

        // Movie servers (Radarr)
        movieServerSelect.innerHTML = '<option value="">Use Seerr default</option>';
        const radarrServers = serversResult.servers.filter(s => s.type === "radarr");
        radarrServers.forEach(server => {
          const option = document.createElement("option");
          option.value = `${server.id}|${server.type}`;
          option.textContent = `${server.name}${server.isDefault ? " (default)" : ""}`;
          movieServerSelect.appendChild(option);
        });
        if (savedMovieServer) movieServerSelect.value = savedMovieServer;

        // TV servers (Sonarr)
        tvServerSelect.innerHTML = '<option value="">Use Seerr default</option>';
        const sonarrServers = serversResult.servers.filter(s => s.type === "sonarr");
        sonarrServers.forEach(server => {
          const option = document.createElement("option");
          option.value = `${server.id}|${server.type}`;
          option.textContent = `${server.name}${server.isDefault ? " (default)" : ""}`;
          tvServerSelect.appendChild(option);
        });
        if (savedTvServer) tvServerSelect.value = savedTvServer;

        const totalProfiles = radarrProfiles.length + sonarrProfiles.length;
        const totalServers = radarrServers.length + sonarrServers.length;
        loadSeerrOptionsStatus.textContent = `Loaded ${totalProfiles} profiles, ${totalServers} servers`;
        loadSeerrOptionsStatus.style.color = "var(--green)";
      } catch (error) {
        loadSeerrOptionsStatus.textContent = error.message || "Failed to load options";
        loadSeerrOptionsStatus.style.color = "#f38ba8";
      } finally {
        loadSeerrOptionsBtn.disabled = false;
      }
    });
  }

  // Test Jellyfin Endpoint
  if (testJellyfinBtn) {
    testJellyfinBtn.addEventListener("click", async () => {
      const url = document.getElementById("JELLYFIN_BASE_URL").value;
      const apiKey = document.getElementById("JELLYFIN_API_KEY").value;

      testJellyfinBtn.disabled = true;
      testJellyfinStatus.textContent = "Testing...";
      testJellyfinStatus.style.color = "var(--text)";

      try {
        const response = await fetch("/api/test-jellyfin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, apiKey }),
        });

        if (response.ok) {
          const result = await response.json();
          testJellyfinStatus.textContent = result.message;
          testJellyfinStatus.style.color = "var(--green)";

          // Auto-fill Server ID if returned
          if (result.serverId) {
            const serverIdInput = document.getElementById("JELLYFIN_SERVER_ID");
            if (serverIdInput) {
              serverIdInput.value = result.serverId;
              // Flash the input to show it was updated
              serverIdInput.style.transition = "background-color 0.5s";
              const originalBg = serverIdInput.style.backgroundColor;
              serverIdInput.style.backgroundColor = "rgba(166, 227, 161, 0.2)"; // Green tint
              setTimeout(() => {
                serverIdInput.style.backgroundColor = originalBg;
              }, 1000);
            }
          }
        } else {
          const result = await response.json();
          throw new Error(result.message);
        }
      } catch (error) {
        testJellyfinStatus.textContent =
          error.message || "Endpoint test failed.";
        testJellyfinStatus.style.color = "#f38ba8"; // Red
      } finally {
        testJellyfinBtn.disabled = false;
      }
    });
  }

  // Test Notification Buttons
  const testNotificationStatus = document.getElementById("test-notification-status");
  const testMovieBtn = document.getElementById("test-movie-notification-btn");
  const testSeriesBtn = document.getElementById("test-series-notification-btn");
  const testSeasonBtn = document.getElementById("test-season-notification-btn");
  const testBatchSeasonsBtn = document.getElementById("test-batch-seasons-notification-btn");
  const testEpisodesBtn = document.getElementById("test-episodes-notification-btn");
  const testBatchEpisodesBtn = document.getElementById("test-batch-episodes-notification-btn");

  async function sendTestNotification(type) {
    const statusEl = testNotificationStatus;
    if (!statusEl) return;

    statusEl.textContent = `Sending test ${type} notification...`;
    statusEl.style.color = "var(--text)";

    try {
      const response = await fetch("/api/test-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });

      const result = await response.json();

      if (response.ok) {
        statusEl.textContent = result.message || `Test ${type} notification sent successfully!`;
        statusEl.style.color = "var(--green)";
      } else {
        throw new Error(result.message || "Failed to send test notification");
      }
    } catch (error) {
      statusEl.textContent = error.message || `Failed to send test ${type} notification`;
      statusEl.style.color = "#f38ba8"; // Red
    }
  }

  if (testMovieBtn) {
    testMovieBtn.addEventListener("click", () => sendTestNotification("movie"));
  }
  if (testSeriesBtn) {
    testSeriesBtn.addEventListener("click", () => sendTestNotification("series"));
  }
  if (testSeasonBtn) {
    testSeasonBtn.addEventListener("click", () => sendTestNotification("season"));
  }
  if (testBatchSeasonsBtn) {
    testBatchSeasonsBtn.addEventListener("click", () => sendTestNotification("batch-seasons"));
  }
  if (testEpisodesBtn) {
    testEpisodesBtn.addEventListener("click", () => sendTestNotification("episodes"));
  }
  if (testBatchEpisodesBtn) {
    testBatchEpisodesBtn.addEventListener("click", () => sendTestNotification("batch-episodes"));
  }

  // Test Random Pick Button
  const testRandomPickBtn = document.getElementById("test-random-pick-btn");
  if (testRandomPickBtn) {
    testRandomPickBtn.addEventListener("click", async () => {
      testRandomPickBtn.disabled = true;
      const originalText = testRandomPickBtn.innerHTML;
      testRandomPickBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Sending...';

      try {
        const response = await fetch("/api/test-random-pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        const result = await response.json();

        if (response.ok) {
          testRandomPickBtn.style.backgroundColor = "var(--green)";
          testRandomPickBtn.innerHTML = '<i class="bi bi-check-circle"></i> Sent!';
          setTimeout(() => {
            testRandomPickBtn.innerHTML = originalText;
            testRandomPickBtn.style.backgroundColor = "";
            testRandomPickBtn.disabled = false;
          }, 2000);
        } else {
          throw new Error(result.message || "Failed to send random pick");
        }
      } catch (error) {
        testRandomPickBtn.style.backgroundColor = "#f38ba8";
        testRandomPickBtn.innerHTML = `<i class="bi bi-exclamation-circle"></i> ${escapeHtml(error.message)}`;
        setTimeout(() => {
          testRandomPickBtn.innerHTML = originalText;
          testRandomPickBtn.style.backgroundColor = "";
          testRandomPickBtn.disabled = false;
        }, 3000);
      }
    });
  }

  // Fetch and display Jellyfin libraries for notifications
  const fetchLibrariesBtn = document.getElementById("fetch-libraries-btn");
  const fetchLibrariesStatus = document.getElementById(
    "fetch-libraries-status"
  );
  const librariesList = document.getElementById("libraries-list");
  const notificationLibrariesInput = document.getElementById(
    "JELLYFIN_NOTIFICATION_LIBRARIES"
  );

  if (fetchLibrariesBtn) {
    fetchLibrariesBtn.addEventListener("click", async () => {
      const url = document.getElementById("JELLYFIN_BASE_URL").value;
      const apiKey = document.getElementById("JELLYFIN_API_KEY").value;

      if (!url || !url.trim()) {
        showToast("Please enter Jellyfin URL first.");
        return;
      }

      if (!apiKey || !apiKey.trim()) {
        showToast("Please enter Jellyfin API Key first.");
        return;
      }

      fetchLibrariesBtn.disabled = true;
      librariesList.innerHTML =
        '<div style="padding: 1rem; text-align: center; color: var(--subtext0);"><i class="bi bi-arrow-repeat" style="animation: spin 1s linear infinite; margin-right: 0.5rem;"></i>Loading libraries...</div>';

      try {
        const response = await fetch("/api/jellyfin-libraries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, apiKey }),
        });

        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.message || "Failed to fetch libraries");
        }

        const result = await response.json();

        if (result.success) {
          const libraries = result.libraries || [];

          if (libraries.length === 0) {
            librariesList.innerHTML =
              '<div class="libraries-empty">No libraries found.</div>';
          } else {
            // Get currently enabled libraries (object format: { libraryId: channelId })
            let libraryChannels = {};
            try {
              const currentValue = notificationLibrariesInput.value;

              if (currentValue && currentValue.trim() !== "") {
                const parsed = JSON.parse(currentValue);
                // Handle both array (legacy) and object format
                if (Array.isArray(parsed)) {
                  // Convert array to object with default channel
                  const defaultChannel =
                    document.getElementById("JELLYFIN_CHANNEL_ID").value || "";
                  parsed.forEach((libId) => {
                    libraryChannels[libId] = defaultChannel;
                  });
                } else if (typeof parsed === "object") {
                  libraryChannels = parsed;
                }
              }
            } catch (e) {
              libraryChannels = {};
            }

            // If no libraries selected yet, enable all by default with default channel
            const allEnabled = Object.keys(libraryChannels).length === 0;
            const defaultChannel =
              document.getElementById("JELLYFIN_CHANNEL_ID").value || "";

            librariesList.innerHTML = libraries
              .map((lib) => {
                // Library is checked ONLY if:
                // 1. No libraries configured yet (allEnabled = true), OR
                // 2. This library ID exists as a key in libraryChannels object
                const isChecked =
                  allEnabled || libraryChannels.hasOwnProperty(lib.id);
                const selectedChannel = isChecked
                  ? libraryChannels[lib.id] || defaultChannel
                  : "";

                return `
              <div class="library-item">
                <label class="library-label">
                  <input
                    type="checkbox"
                    value="${lib.id}"
                    class="library-checkbox"
                    ${isChecked ? "checked" : ""}
                  />
                  <div class="library-info">
                    <span class="library-name">${lib.name}</span>
                  </div>
                </label>
                <select
                  class="library-channel-select"
                  data-library-id="${lib.id}"
                  ${!isChecked ? "disabled" : ""}
                >
                  <option value="">Use Default Channel</option>
                </select>
              </div>
            `;
              })
              .join("");

            // Add TV Seasons and Episodes section
            const episodesEnabled = document.getElementById("JELLYFIN_NOTIFY_EPISODES").value === "true";
            const seasonsEnabled = document.getElementById("JELLYFIN_NOTIFY_SEASONS").value === "true";
            const episodeChannel = document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID").value || "";
            const seasonChannel = document.getElementById("JELLYFIN_SEASON_CHANNEL_ID").value || "";

            librariesList.innerHTML += `
              <div style="padding: 1rem 0.75rem 0.5rem; margin-top: 1rem; border-top: 1px solid var(--surface1);">
                <span style="font-size: 0.9rem; font-weight: 600; color: var(--mauve); text-transform: uppercase; letter-spacing: 0.05em;">TV Seasons and Episodes Mapping</span>
              </div>
              
              <div class="library-item">
                <label class="library-label">
                  <input
                    type="checkbox"
                    id="episodes-notify-checkbox"
                    class="library-checkbox"
                    ${episodesEnabled ? "checked" : ""}
                  />
                  <div class="library-info">
                    <span class="library-name">Episodes</span>
                    <span class="library-type">New episode notifications</span>
                  </div>
                </label>
                <select
                  id="episodes-channel-select"
                  class="library-channel-select"
                  ${!episodesEnabled ? "disabled" : ""}
                >
                  <option value="">Use Default Channel</option>
                </select>
              </div>

              <div class="library-item">
                <label class="library-label">
                  <input
                    type="checkbox"
                    id="seasons-notify-checkbox"
                    class="library-checkbox"
                    ${seasonsEnabled ? "checked" : ""}
                  />
                  <div class="library-info">
                    <span class="library-name">Seasons</span>
                    <span class="library-type">New season notifications</span>
                  </div>
                </label>
                <select
                  id="seasons-channel-select"
                  class="library-channel-select"
                  ${!seasonsEnabled ? "disabled" : ""}
                >
                  <option value="">Use Default Channel</option>
                </select>
              </div>
            `;

            // Populate channel dropdowns
            populateLibraryChannelDropdowns(libraryChannels);

            // Add change listeners to all checkboxes
            librariesList
              .querySelectorAll(".library-checkbox")
              .forEach((cb) => {
                cb.addEventListener("change", (e) => {
                  const libraryId = e.target.value;
                  const select = librariesList.querySelector(
                    `select[data-library-id="${libraryId}"]`
                  );
                  if (select) {
                    select.disabled = !e.target.checked;
                  }
                  updateNotificationLibraries();
                });
              });

            // Add change listeners to all channel selects
            librariesList
              .querySelectorAll(".library-channel-select")
              .forEach((select) => {
                select.addEventListener("change", updateNotificationLibraries);
              });

            // Add event listeners for Episodes and Seasons checkboxes
            const episodesCheckbox = document.getElementById("episodes-notify-checkbox");
            const seasonsCheckbox = document.getElementById("seasons-notify-checkbox");
            const episodesSelect = document.getElementById("episodes-channel-select");
            const seasonsSelect = document.getElementById("seasons-channel-select");

            if (episodesCheckbox && episodesSelect) {
              episodesCheckbox.addEventListener("change", (e) => {
                episodesSelect.disabled = !e.target.checked;
                document.getElementById("JELLYFIN_NOTIFY_EPISODES").value = e.target.checked ? "true" : "";
              });
              episodesSelect.addEventListener("change", (e) => {
                document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID").value = e.target.value;
              });
            }

            if (seasonsCheckbox && seasonsSelect) {
              seasonsCheckbox.addEventListener("change", (e) => {
                seasonsSelect.disabled = !e.target.checked;
                document.getElementById("JELLYFIN_NOTIFY_SEASONS").value = e.target.checked ? "true" : "";
              });
              seasonsSelect.addEventListener("change", (e) => {
                document.getElementById("JELLYFIN_SEASON_CHANNEL_ID").value = e.target.value;
              });
            }

            // DON'T call updateNotificationLibraries() here - it would overwrite the saved config
            // The hidden input already has the correct value from fetchConfig()
          }

          // Libraries loaded successfully
        }
      } catch (error) {
        librariesList.innerHTML = `<div style="padding: 1rem; color: var(--red); background: var(--surface0); border-radius: 6px;">
          <i class="bi bi-exclamation-triangle" style="margin-right: 0.5rem;"></i>${escapeHtml(
            error.message ||
            "Failed to load libraries. Please check your Jellyfin URL and API Key."
          )}
        </div>`;
      } finally {
        fetchLibrariesBtn.disabled = false;
      }
    });
  }

  // Populate channel dropdowns with available Discord channels
  async function populateLibraryChannelDropdowns(libraryChannels) {
    const guildId = document.getElementById("GUILD_ID").value;
    if (!guildId) {
      return; // Can't fetch channels without guild ID
    }

    try {
      const response = await fetch(`/api/discord/channels/${guildId}`);
      if (!response.ok) return;

      const data = await response.json();
      if (!data.success || !data.channels) return;

      const channels = data.channels;
      const selects = librariesList.querySelectorAll(".library-channel-select");

      selects.forEach((select) => {
        const libraryId = select.dataset.libraryId;
        const currentChannel = libraryChannels[libraryId] || "";

        // Clear and populate options
        select.innerHTML =
          '<option value="">Use Default Channel</option>' +
          channels
            .map((ch) => {
              let icon = "";
              if (ch.type === "announcement") icon = " 📢";
              else if (ch.type === "forum-thread") icon = " 🧵";
              return `<option value="${ch.id}" ${
                currentChannel === ch.id ? "selected" : ""
              }>#${ch.name}${icon}</option>`;
            })
            .join("");

        // Ensure the value is set (in case the selected attribute didn't work)
        if (currentChannel) {
          select.value = currentChannel;
        }
      });

      // Populate Episodes and Seasons channel selects
      const episodesSelect = document.getElementById("episodes-channel-select");
      const seasonsSelect = document.getElementById("seasons-channel-select");
      const episodeChannel = document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID").value || "";
      const seasonChannel = document.getElementById("JELLYFIN_SEASON_CHANNEL_ID").value || "";

      if (episodesSelect) {
        episodesSelect.innerHTML =
          '<option value="">Use Default Channel</option>' +
          channels
            .map((ch) => {
              let icon = "";
              if (ch.type === "announcement") icon = " 📢";
              else if (ch.type === "forum-thread") icon = " 🧵";
              return `<option value="${ch.id}" ${
                episodeChannel === ch.id ? "selected" : ""
              }>#${ch.name}${icon}</option>`;
            })
            .join("");
        if (episodeChannel) {
          episodesSelect.value = episodeChannel;
        }
      }

      if (seasonsSelect) {
        seasonsSelect.innerHTML =
          '<option value="">Use Default Channel</option>' +
          channels
            .map((ch) => {
              let icon = "";
              if (ch.type === "announcement") icon = " 📢";
              else if (ch.type === "forum-thread") icon = " 🧵";
              return `<option value="${ch.id}" ${
                seasonChannel === ch.id ? "selected" : ""
              }>#${ch.name}${icon}</option>`;
            })
            .join("");
        if (seasonChannel) {
          seasonsSelect.value = seasonChannel;
        }
      }
    } catch (error) {}
  }

  // Update the hidden input with selected notification libraries (object format)
  function updateNotificationLibraries() {
    const checkboxes = librariesList.querySelectorAll(
      ".library-checkbox:checked"
    );
    const libraryChannels = {};

    checkboxes.forEach((cb) => {
      const libraryId = cb.value;
      if (!libraryId || libraryId.trim() === "") {
        return;
      }
      const select = librariesList.querySelector(
        `select[data-library-id="${libraryId}"]`
      );
      const channelId = select ? select.value : "";
      libraryChannels[libraryId] = channelId; // Empty string means "use default"
    });

    const jsonValue = JSON.stringify(libraryChannels);
    notificationLibrariesInput.value = jsonValue;
  }

  // --- Initial Load ---
  checkAuth();

  // Helper function to check and load mappings tab
  function checkAndLoadMappingsTab() {
    const activePane = document.querySelector(".config-pane.active");
    if (activePane && activePane.id === "config-pane-mappings") {
      loadMappings();
    }
  }

  // --- Discord Guild & Channel Selection ---
  async function loadDiscordGuilds() {
    const tokenInput = document.getElementById("DISCORD_TOKEN");
    const botIdInput = document.getElementById("BOT_ID");
    const guildSelect = document.getElementById("GUILD_ID");

    if (!guildSelect) return;

    // Reset to default state if no token
    if (!tokenInput?.value || !botIdInput?.value) {
      guildSelect.innerHTML =
        '<option value="">Enter Discord Token and Bot ID first...</option>';
      return;
    }

    guildSelect.innerHTML = '<option value="">Loading servers...</option>';

    try {
      const response = await fetch("/api/discord/guilds");
      const data = await response.json();

      if (data.success && data.guilds) {
        guildSelect.innerHTML = '<option value="">Select a server...</option>';
        data.guilds.forEach((guild) => {
          const option = document.createElement("option");
          option.value = guild.id;
          option.textContent = guild.name;
          guildSelect.appendChild(option);
        });

        // Restore saved value if exists
        const currentValue = guildSelect.dataset.savedValue;
        if (currentValue) {
          guildSelect.value = currentValue;
          // If value was successfully set, load channels for that guild
          if (guildSelect.value === currentValue) {
            loadDiscordChannels(currentValue);
          }
        }
      } else {
        guildSelect.innerHTML =
          `<option value="">${t('errors.loading_servers_check_token')}</option>`;
      }
    } catch (error) {
      guildSelect.innerHTML = `<option value="">${t('errors.loading_servers')}</option>`;
    }
  }

  async function loadDiscordChannels(guildId) {
    const channelSelect = document.getElementById("JELLYFIN_CHANNEL_ID");
    const episodeChannelSelect = document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID");
    const seasonChannelSelect = document.getElementById("JELLYFIN_SEASON_CHANNEL_ID");
    const dailyRandomPickChannelSelect = document.getElementById("DAILY_RANDOM_PICK_CHANNEL_ID");

    if (!guildId) {
      if (channelSelect) {
        channelSelect.innerHTML =
          '<option value="">Select a server first...</option>';
      }
      if (episodeChannelSelect) {
        episodeChannelSelect.innerHTML =
          `<option value="">${t('config.use_default_channel')}</option>`;
      }
      if (seasonChannelSelect) {
        seasonChannelSelect.innerHTML =
          `<option value="">${t('config.use_default_channel')}</option>`;
      }
      if (dailyRandomPickChannelSelect) {
        dailyRandomPickChannelSelect.innerHTML =
          '<option value="">Select a channel...</option>';
      }
      return;
    }

    // Set loading state for all selects
    if (channelSelect) {
      channelSelect.innerHTML = '<option value="">Loading channels...</option>';
    }
    if (episodeChannelSelect) {
      episodeChannelSelect.innerHTML = '<option value="">Loading channels...</option>';
    }
    if (seasonChannelSelect) {
      seasonChannelSelect.innerHTML = '<option value="">Loading channels...</option>';
    }
    if (dailyRandomPickChannelSelect) {
      dailyRandomPickChannelSelect.innerHTML = '<option value="">Loading channels...</option>';
    }

    try {
      const response = await fetch(`/api/discord/channels/${guildId}`);
      const data = await response.json();

      if (data.success && data.channels) {
        // Populate main channel select
        if (channelSelect) {
          channelSelect.innerHTML =
            '<option value="">Select a channel...</option>';
          data.channels.forEach((channel) => {
            const option = document.createElement("option");
            option.value = channel.id;
            let icon = "";
            if (channel.type === "announcement") icon = " 📢";
            else if (channel.type === "forum-thread") icon = " 🧵";
            option.textContent = `#${channel.name}${icon}`;
            channelSelect.appendChild(option);
          });

          // Restore saved value if exists
          const currentValue = channelSelect.dataset.savedValue;
          if (currentValue) {
            channelSelect.value = currentValue;
          }
        }

        // Populate episode channel select (optional)
        if (episodeChannelSelect) {
          episodeChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
          data.channels.forEach((channel) => {
            const option = document.createElement("option");
            option.value = channel.id;
            let icon = "";
            if (channel.type === "announcement") icon = " 📢";
            else if (channel.type === "forum-thread") icon = " 🧵";
            option.textContent = `#${channel.name}${icon}`;
            episodeChannelSelect.appendChild(option);
          });

          // Restore saved value if exists
          const currentValue = episodeChannelSelect.dataset.savedValue;
          if (currentValue) {
            episodeChannelSelect.value = currentValue;
          }
        }

        // Populate season channel select (optional)
        if (seasonChannelSelect) {
          seasonChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
          data.channels.forEach((channel) => {
            const option = document.createElement("option");
            option.value = channel.id;
            let icon = "";
            if (channel.type === "announcement") icon = " 📢";
            else if (channel.type === "forum-thread") icon = " 🧵";
            option.textContent = `#${channel.name}${icon}`;
            seasonChannelSelect.appendChild(option);
          });

          // Restore saved value if exists
          const currentValue = seasonChannelSelect.dataset.savedValue;
          if (currentValue) {
            seasonChannelSelect.value = currentValue;
          }
        }

        // Populate daily random pick channel select
        if (dailyRandomPickChannelSelect) {
          dailyRandomPickChannelSelect.innerHTML =
            '<option value="">Select a channel...</option>';
          data.channels.forEach((channel) => {
            const option = document.createElement("option");
            option.value = channel.id;
            let icon = "";
            if (channel.type === "announcement") icon = " 📢";
            else if (channel.type === "forum-thread") icon = " 🧵";
            option.textContent = `#${channel.name}${icon}`;
            dailyRandomPickChannelSelect.appendChild(option);
          });

          // Restore saved value if exists
          const currentValue = dailyRandomPickChannelSelect.dataset.savedValue;
          if (currentValue) {
            dailyRandomPickChannelSelect.value = currentValue;
          }
        }
      } else {
        if (channelSelect) {
          channelSelect.innerHTML =
            `<option value="">${t('errors.loading_channels')}</option>`;
        }
        if (episodeChannelSelect) {
          episodeChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
        }
        if (seasonChannelSelect) {
          seasonChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
        }
        if (dailyRandomPickChannelSelect) {
          dailyRandomPickChannelSelect.innerHTML =
            '<option value="">Select a channel...</option>';
        }
      }
    } catch (error) {
      if (channelSelect) {
        channelSelect.innerHTML =
          `<option value="">${t('errors.loading_channels')}</option>`;
      }
      if (episodeChannelSelect) {
        episodeChannelSelect.innerHTML =
          `<option value="">${t('config.use_default_channel')}</option>`;
      }
      if (seasonChannelSelect) {
        seasonChannelSelect.innerHTML =
          `<option value="">${t('config.use_default_channel')}</option>`;
      }
      if (dailyRandomPickChannelSelect) {
        dailyRandomPickChannelSelect.innerHTML =
          '<option value="">Select a channel...</option>';
      }
    }
  }

  // Listen for guild selection changes
  const guildSelect = document.getElementById("GUILD_ID");
  if (guildSelect) {
    guildSelect.addEventListener("change", (e) => {
      if (e.target.value) {
        loadDiscordChannels(e.target.value);
      } else {
        const channelSelect = document.getElementById("JELLYFIN_CHANNEL_ID");
        const episodeChannelSelect = document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID");
        const seasonChannelSelect = document.getElementById("JELLYFIN_SEASON_CHANNEL_ID");
        const dailyRandomPickChannelSelect = document.getElementById("DAILY_RANDOM_PICK_CHANNEL_ID");
        
        if (channelSelect) {
          channelSelect.innerHTML =
            '<option value="">Select a server first...</option>';
        }
        if (episodeChannelSelect) {
          episodeChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
        }
        if (seasonChannelSelect) {
          seasonChannelSelect.innerHTML =
            `<option value="">${t('config.use_default_channel')}</option>`;
        }
        if (dailyRandomPickChannelSelect) {
          dailyRandomPickChannelSelect.innerHTML =
            '<option value="">Select a channel...</option>';
        }
      }
    });
  }

  // Listen for token/bot ID changes to reload guilds
  const tokenInput = document.getElementById("DISCORD_TOKEN");
  const botIdInput = document.getElementById("BOT_ID");

  if (tokenInput) {
    tokenInput.addEventListener("blur", () => {
      if (tokenInput.value && botIdInput?.value) {
        loadDiscordGuilds();
      }
    });
  }

  if (botIdInput) {
    botIdInput.addEventListener("blur", () => {
      if (botIdInput.value && tokenInput?.value) {
        loadDiscordGuilds();
      }
    });
  }

  // --- Episodes and Seasons Notification Controls ---
  const episodesCheckbox = document.getElementById("JELLYFIN_NOTIFY_EPISODES_CHECKBOX");
  const seasonsCheckbox = document.getElementById("JELLYFIN_NOTIFY_SEASONS_CHECKBOX");
  const episodeChannelSelect = document.getElementById("JELLYFIN_EPISODE_CHANNEL_ID");
  const seasonChannelSelect = document.getElementById("JELLYFIN_SEASON_CHANNEL_ID");
  const episodesHidden = document.getElementById("JELLYFIN_NOTIFY_EPISODES");
  const seasonsHidden = document.getElementById("JELLYFIN_NOTIFY_SEASONS");

  if (episodesCheckbox && episodeChannelSelect && episodesHidden) {
    episodesCheckbox.addEventListener("change", (e) => {
      episodeChannelSelect.disabled = !e.target.checked;
      episodesHidden.value = e.target.checked ? "true" : "false";
    });
  }

  if (seasonsCheckbox && seasonChannelSelect && seasonsHidden) {
    seasonsCheckbox.addEventListener("change", (e) => {
      seasonChannelSelect.disabled = !e.target.checked;
      seasonsHidden.value = e.target.checked ? "true" : "false";
    });
  }

  // --- User Mappings ---
  let seerrUsers = [];
  let discordMembers = [];
  let currentMappings = []; // Will be array of enriched objects with metadata
  let membersLoaded = false; // Track if we've loaded members for the dropdown
  let usersLoaded = false; // Track if we've loaded seerr users

  // Cache keys
  const DISCORD_MEMBERS_CACHE_KEY = "anchorr_discord_members_cache";
  const SEERR_USERS_CACHE_KEY = "anchorr_seerr_users_cache";
  const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

  // Load from cache
  function loadFromCache(key) {
    try {
      const cached = localStorage.getItem(key);
      if (!cached) return null;

      const data = JSON.parse(cached);
      const now = Date.now();

      if (now - data.timestamp > CACHE_DURATION) {
        localStorage.removeItem(key);
        return null;
      }

      return data.value;
    } catch (error) {
      return null;
    }
  }

  // Save to cache
  function saveToCache(key, value) {
    try {
      const data = {
        value: value,
        timestamp: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(data));
    } catch (error) {
      // Cache save error
    }
  }

  async function loadDiscordMembers(forceRefresh = false) {
    // Try cache first
    if (!forceRefresh) {
      const cachedMembers = loadFromCache(DISCORD_MEMBERS_CACHE_KEY);
      if (cachedMembers && cachedMembers.length > 0) {
        discordMembers = cachedMembers;
        membersLoaded = true;
        populateDiscordMemberSelect();
        return;
      }
    }

    if (membersLoaded && discordMembers.length > 0 && !forceRefresh) {
      return;
    }

    try {
      const response = await fetch("/api/discord-members");
      const data = await response.json();

      if (data.success && data.members) {
        discordMembers = data.members;
        membersLoaded = true;
        saveToCache(DISCORD_MEMBERS_CACHE_KEY, data.members);
        populateDiscordMemberSelect();
      } else {
        const customSelect = document.getElementById("discord-user-select");
        if (customSelect) {
          const trigger = customSelect.querySelector(".custom-select-trigger");
          if (trigger) {
            trigger.placeholder = t('errors.loading_members_bot_running');
          }
        }
      }
    } catch (error) {
      const customSelect = document.getElementById("discord-user-select");
      if (customSelect) {
        const trigger = customSelect.querySelector(".custom-select-trigger");
        if (trigger) {
          trigger.placeholder = t('errors.loading_members');
        }
      }
    }
  }

  function populateDiscordMemberSelect() {
    const customSelect = document.getElementById("discord-user-select");
    if (!customSelect) return;

    const optionsContainer = customSelect.querySelector(
      ".custom-select-options"
    );
    if (!optionsContainer) return;

    optionsContainer.innerHTML = "";

    discordMembers.forEach((member) => {
      const option = document.createElement("div");
      option.className = "custom-select-option";
      option.dataset.value = member.id;
      option.dataset.displayName = member.displayName;
      option.dataset.username = member.username;
      option.dataset.avatar = member.avatar || "";

      // Check if this member is already in active mappings
      const isInMapping = currentMappings.some(
        (mapping) => mapping.discordUserId === member.id
      );

      // Build option content safely via DOM APIs (no avatar URL interpolation into innerHTML)
      const textContainer = document.createElement("div");
      textContainer.className = "custom-select-option-text";
      const nameDiv = document.createElement("div");
      nameDiv.className = "custom-select-option-name";
      nameDiv.textContent = member.displayName;
      const usernameDiv = document.createElement("div");
      usernameDiv.className = "custom-select-option-username";
      usernameDiv.textContent = "@" + member.username;
      textContainer.appendChild(nameDiv);
      textContainer.appendChild(usernameDiv);
      const avatarImg = document.createElement("img");
      avatarImg.alt = member.displayName || "";
      if (isSafeAvatarUrl(member.avatar)) {
        avatarImg.src = member.avatar;
      }
      option.appendChild(avatarImg);
      option.appendChild(textContainer);
      if (isInMapping) {
        const checkIcon = document.createElement("i");
        checkIcon.className = "bi bi-check-circle-fill";
        checkIcon.style.color = "var(--green)";
        checkIcon.style.marginLeft = "auto";
        checkIcon.style.fontSize = "1.1rem";
        option.appendChild(checkIcon);
      }

      option.addEventListener("click", () => {
        selectDiscordUser(member);
      });

      optionsContainer.appendChild(option);
    });
  }

  function selectDiscordUser(member) {
    const customSelect = document.getElementById("discord-user-select");
    const trigger = customSelect.querySelector(".custom-select-trigger");

    // Store selected value
    customSelect.dataset.value = member.id;
    customSelect.dataset.displayName = member.displayName;
    customSelect.dataset.username = member.username;

    // Add has-selection class to hide input
    customSelect.classList.add("has-selection");

    // Create or update display element
    let display = customSelect.querySelector(".custom-select-display");
    if (!display) {
      display = document.createElement("div");
      display.className = "custom-select-display";
      customSelect.insertBefore(
        display,
        customSelect.querySelector(".custom-select-dropdown")
      );
    }

    // Safely build selected display using DOM APIs
    while (display.firstChild) {
      display.removeChild(display.firstChild);
    }
    const img = document.createElement("img");
    img.alt = member.displayName || "";
    if (isSafeAvatarUrl(member.avatar)) {
      img.src = member.avatar;
    }
    const span = document.createElement("span");
    span.textContent = `${member.displayName} (@${member.username})`;
    display.appendChild(img);
    display.appendChild(span);

    // Force display to be visible immediately
    display.style.display = "flex";
    trigger.style.display = "none";

    // Mark as selected in options
    const options = customSelect.querySelectorAll(".custom-select-option");
    options.forEach((opt) => {
      if (opt.dataset.value === member.id) {
        opt.classList.add("selected");
      } else {
        opt.classList.remove("selected");
      }
    });

    // Close dropdown and reset input
    customSelect.classList.remove("active");
    trigger.value = "";
    trigger.setAttribute("readonly", "");
  }

  async function loadSeerrUsers(forceRefresh = false) {
    // Try cache first
    if (!forceRefresh) {
      const cachedUsers = loadFromCache(SEERR_USERS_CACHE_KEY);
      if (cachedUsers && cachedUsers.length > 0) {
        seerrUsers = cachedUsers;
        usersLoaded = true;
        populateSeerrUserSelect();
        return;
      }
    }

    if (usersLoaded && seerrUsers.length > 0 && !forceRefresh) {
      return;
    }

    try {
      const response = await fetch("/api/seerr-users");
      const data = await response.json();

      if (data.success && data.users) {
        seerrUsers = data.users;
        usersLoaded = true;
        saveToCache(SEERR_USERS_CACHE_KEY, data.users);
        populateSeerrUserSelect();
      }
    } catch (error) {}
  }

  function populateSeerrUserSelect() {
    const customSelect = document.getElementById("seerr-user-select");
    if (!customSelect) return;

    const optionsContainer = customSelect.querySelector(
      ".custom-select-options"
    );
    if (!optionsContainer) return;

    optionsContainer.innerHTML = "";

    seerrUsers.forEach((user) => {
      const option = document.createElement("div");
      option.className = "custom-select-option";
      option.dataset.value = user.id;
      option.dataset.displayName = user.displayName;
      option.dataset.email = user.email || "";
      option.dataset.avatar = user.avatar || "";

      // Check if this user is already in active mappings
      const isInMapping = currentMappings.some(
        (mapping) => String(mapping.seerrUserId) === String(user.id)
      );
      const checkmarkHtml = isInMapping
        ? `<i class="bi bi-check-circle-fill" style="color: var(--green); margin-left: auto; font-size: 1.1rem;"></i>`
        : "";

      option.innerHTML = `
        <div class="custom-select-option-text">
          <div class="custom-select-option-name">${escapeHtml(user.displayName)}</div>
          ${
            user.email
              ? `<div class="custom-select-option-username">${escapeHtml(user.email)}</div>`
              : ""
          }
        </div>
        ${checkmarkHtml}
      `;
      // Safely insert avatar using DOM API (no string interpolation)
      if (user.avatar && isSafeAvatarUrl(user.avatar)) {
        const img = document.createElement("img");
        img.src = user.avatar;
        img.alt = user.displayName || "";
        option.insertBefore(img, option.firstChild);
      } else {
        const fallback = document.createElement("div");
        fallback.style.cssText = "width:36px;height:36px;border-radius:50%;background:var(--surface1);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--mauve);flex-shrink:0";
        fallback.textContent = user.displayName ? user.displayName.charAt(0).toUpperCase() : "?";
        option.insertBefore(fallback, option.firstChild);
      }

      option.addEventListener("click", () => {
        selectSeerrUser(user);
      });

      optionsContainer.appendChild(option);
    });
  }

  function selectSeerrUser(user) {
    const customSelect = document.getElementById("seerr-user-select");
    const trigger = customSelect.querySelector(".custom-select-trigger");

    // Store selected value
    customSelect.dataset.value = user.id;
    customSelect.dataset.displayName = user.displayName;
    customSelect.dataset.email = user.email || "";
    customSelect.dataset.avatar = user.avatar || "";

    // Add has-selection class to hide input
    customSelect.classList.add("has-selection");

    // Create or update display element
    let display = customSelect.querySelector(".custom-select-display");
    if (!display) {
      display = document.createElement("div");
      display.className = "custom-select-display";
      customSelect.insertBefore(
        display,
        customSelect.querySelector(".custom-select-dropdown")
      );
    }

    // Safely build selected display using DOM API (no string interpolation for URLs)
    while (display.firstChild) {
      display.removeChild(display.firstChild);
    }
    if (user.avatar && isSafeAvatarUrl(user.avatar)) {
      const img = document.createElement("img");
      img.src = user.avatar;
      img.alt = user.displayName || "";
      img.style.cssText = "width:32px;height:32px;border-radius:50%;margin-right:0.75rem;flex-shrink:0";
      display.appendChild(img);
    } else {
      const fallback = document.createElement("div");
      fallback.style.cssText = "width:32px;height:32px;border-radius:50%;background:var(--surface1);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--mauve);flex-shrink:0;margin-right:0.75rem";
      fallback.textContent = user.displayName ? user.displayName.charAt(0).toUpperCase() : "?";
      display.appendChild(fallback);
    }
    const nameSpan = document.createElement("span");
    nameSpan.textContent = user.email
      ? `${user.displayName} (${user.email})`
      : (user.displayName || "");
    display.appendChild(nameSpan);

    // Force display to be visible immediately
    display.style.display = "flex";
    trigger.style.display = "none";

    // Mark as selected in options
    const options = customSelect.querySelectorAll(".custom-select-option");
    options.forEach((opt) => {
      if (opt.dataset.value === String(user.id)) {
        opt.classList.add("selected");
      } else {
        opt.classList.remove("selected");
      }
    });

    // Close dropdown and reset input
    customSelect.classList.remove("active");
    trigger.value = "";
    trigger.setAttribute("readonly", "");
  }

  async function loadMappings() {
    try {
      const response = await fetch("/api/user-mappings");
      currentMappings = await response.json(); // Array with metadata

      // Always try to load members from cache first
      if (!membersLoaded && currentMappings.length > 0) {
        await loadDiscordMembers(); // Will use cache if available
      }

      // Load Seerr users if not loaded
      if (!usersLoaded && currentMappings.length > 0) {
        await loadSeerrUsers();
      }

      // Check if we need to update any mappings with missing metadata
      let needsUpdate = false;
      for (const mapping of currentMappings) {
        if (!mapping.discordDisplayName || !mapping.seerrDisplayName) {
          needsUpdate = true;
          break;
        }
      }

      // If mappings need update and we have the data loaded, update them
      if (needsUpdate && membersLoaded && usersLoaded) {
        await updateMappingsMetadata();
      }

      // Display mappings (with avatars if members loaded)
      displayMappings();
    } catch (error) {}
  }

  // Update mappings that have missing metadata
  async function updateMappingsMetadata() {
    try {
      for (const mapping of currentMappings) {
        if (
          !mapping.discordDisplayName ||
          !mapping.discordAvatar ||
          !mapping.seerrDisplayName
        ) {
          const discordMember = discordMembers.find(
            (m) => m.id === mapping.discordUserId
          );
          const seerrUser = seerrUsers.find(
            (u) => String(u.id) === String(mapping.seerrUserId)
          );

          if (discordMember || seerrUser) {
            const updatedData = {
              discordUserId: mapping.discordUserId,
              seerrUserId: mapping.seerrUserId,
              discordUsername:
                discordMember?.username || mapping.discordUsername,
              discordDisplayName:
                discordMember?.displayName || mapping.discordDisplayName,
              discordAvatar: discordMember?.avatar || mapping.discordAvatar,
              seerrDisplayName:
                seerrUser?.displayName || mapping.seerrDisplayName,
            };

            await fetch("/api/user-mappings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updatedData),
            });
          }
        }
      }

      // Reload mappings after update
      const response = await fetch("/api/user-mappings");
      currentMappings = await response.json();
    } catch (error) {}
  }

  function displayMappings() {
    const container = document.getElementById("mappings-list");
    if (!container) return;

    if (!Array.isArray(currentMappings) || currentMappings.length === 0) {
      container.innerHTML =
        '<p style="opacity: 0.7; font-style: italic;">No user mappings configured yet.</p>';
      return;
    }

    container.innerHTML = currentMappings
      .map((mapping) => {
        // Always prefer saved display names, fallback to IDs only if nothing saved
        const discordName = mapping.discordDisplayName
          ? `${mapping.discordDisplayName}${
              mapping.discordUsername ? ` (@${mapping.discordUsername})` : ""
            }`
          : mapping.discordUsername
          ? `@${mapping.discordUsername}`
          : `Discord ID: ${mapping.discordUserId}`;

        // Dynamic lookup for Seerr user to ensure fresh data
        let seerrName = mapping.seerrDisplayName;
        const seerrUser = seerrUsers.find(
          (u) => String(u.id) === String(mapping.seerrUserId)
        );

        if (seerrUser) {
          seerrName = seerrUser.displayName;
          if (seerrUser.email) {
            seerrName += ` (${seerrUser.email})`;
          }
        } else if (!seerrName) {
          seerrName = `Seerr ID: ${mapping.seerrUserId}`;
        }

        // Avatar priority: saved in mapping -> find from loaded members -> no avatar
        let avatarUrl = mapping.discordAvatar;
        if (!avatarUrl) {
          const discordMember = discordMembers.find(
            (m) => m.id === mapping.discordUserId
          );
          avatarUrl = discordMember?.avatar;
        }

        const safeAvatarUrl = isSafeAvatarUrl(avatarUrl)
          ? new URL(avatarUrl, window.location.origin).href
          : null;
        const avatarHtml = safeAvatarUrl
          ? `<img src="${escapeHtml(safeAvatarUrl)}" style="width: 42px; height: 42px; border-radius: 50%; margin-right: 0.75rem; flex-shrink: 0;" alt="${escapeHtml(discordName)}">`
          : "";

        return `
        <div class="mapping-item">
          <div style="display: flex; align-items: center;">
            ${avatarHtml}
            <div>
              <div style="font-weight: 600; color: var(--blue);">${escapeHtml(
                discordName
              )}</div>
              <div style="opacity: 0.8; font-size: 0.9rem;">→ Seerr: ${escapeHtml(
                seerrName
              )}</div>
            </div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="deleteMapping('${
            escapeHtml(mapping.discordUserId)
          }')" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">
            <i class="bi bi-trash"></i> Remove
          </button>
        </div>
      `;
      })
      .join("");
  }

  window.deleteMapping = async function (discordUserId) {
    if (!confirm(`Remove mapping for Discord user ${discordUserId}?`)) return;

    try {
      const response = await fetch(`/api/user-mappings/${discordUserId}`, {
        method: "DELETE",
      });
      const result = await response.json();

      if (result.success) {
        showToast("Mapping removed successfully!");
        await loadMappings();
      } else {
        showToast(`Error: ${result.message}`);
      }
    } catch (error) {
      showToast("Failed to remove mapping.");
    }
  };

  const addMappingBtn = document.getElementById("add-mapping-btn");
  if (addMappingBtn) {
    addMappingBtn.addEventListener("click", async () => {
      const discordSelect = document.getElementById("discord-user-select");
      const seerrSelect = document.getElementById(
        "seerr-user-select"
      );
      const discordUserId = discordSelect.dataset.value;
      const seerrUserId = seerrSelect.dataset.value;

      if (!discordUserId || !seerrUserId) {
        showToast("Please select both a Discord user and a Seerr user.");
        return;
      }

      // Extract display names and avatar from the selected options
      const discordMember = discordMembers.find((m) => m.id === discordUserId);
      const seerrUser = seerrUsers.find(
        (u) => String(u.id) === String(seerrUserId)
      );

      // Prepare data for submission
      const mappingData = {
        discordUserId,
        seerrUserId,
        discordUsername: discordMember?.username || null,
        discordDisplayName: discordMember?.displayName || null,
        discordAvatar: discordMember?.avatar || null,
        seerrDisplayName: seerrUser?.displayName || null,
      };

      try {
        const response = await fetch("/api/user-mappings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mappingData),
        });
        const result = await response.json();

        if (result.success) {
          showToast("Mapping added successfully!");

          // Reset Discord custom select
          delete discordSelect.dataset.value;
          delete discordSelect.dataset.displayName;
          delete discordSelect.dataset.username;
          discordSelect.classList.remove("has-selection");
          const discordDisplay = discordSelect.querySelector(
            ".custom-select-display"
          );
          if (discordDisplay) discordDisplay.remove();
          const discordTrigger = discordSelect.querySelector(
            ".custom-select-trigger"
          );
          discordTrigger.value = "";
          discordTrigger.style.display = "block";

          // Reset Seerr custom select
          delete seerrSelect.dataset.value;
          delete seerrSelect.dataset.displayName;
          delete seerrSelect.dataset.email;
          seerrSelect.classList.remove("has-selection");
          const seerrDisplay = seerrSelect.querySelector(
            ".custom-select-display"
          );
          if (seerrDisplay) seerrDisplay.remove();
          const seerrTrigger = seerrSelect.querySelector(
            ".custom-select-trigger"
          );
          seerrTrigger.value = "";
          seerrTrigger.style.display = "block";

          await loadMappings();
        } else {
          showToast(`Error: ${result.message}`);
        }
      } catch (error) {
        showToast("Failed to add mapping.");
      }
    });
  }

  // Refresh All Users button (Discord + Seerr)
  const refreshAllUsersBtn = document.getElementById("refresh-all-users-btn");
  if (refreshAllUsersBtn) {
    refreshAllUsersBtn.addEventListener("click", async () => {
      refreshAllUsersBtn.disabled = true;
      const originalHtml = refreshAllUsersBtn.innerHTML;
      refreshAllUsersBtn.innerHTML =
        '<i class="bi bi-arrow-clockwise" style="animation: spin 1s linear infinite;"></i> Loading...';

      try {
        // Clear local caches
        localStorage.removeItem(DISCORD_MEMBERS_CACHE_KEY);
        localStorage.removeItem(SEERR_USERS_CACHE_KEY);
        membersLoaded = false;
        usersLoaded = false;

        // Fetch both in parallel for better performance
        const [discordResponse, seerrResponse] = await Promise.all([
          fetch("/api/discord-members"),
          fetch("/api/seerr-users"),
        ]);

        const discordData = await discordResponse.json();
        const seerrData = await seerrResponse.json();

        let successCount = 0;
        const messages = [];

        // Process Discord members
        if (discordData.success && discordData.members) {
          discordMembers = discordData.members;
          membersLoaded = true;
          saveToCache(DISCORD_MEMBERS_CACHE_KEY, discordData.members);
          populateDiscordMemberSelect();
          successCount++;
          messages.push(
            discordData.fetchedRealtime
              ? "Discord (real-time)"
              : "Discord (cached)"
          );
        } else {
          messages.push("Discord ❌");
        }

        // Process Seerr users
        if (seerrData.success && seerrData.users) {
          seerrUsers = seerrData.users;
          usersLoaded = true;
          saveToCache(SEERR_USERS_CACHE_KEY, seerrData.users);
          populateSeerrUserSelect();
          successCount++;
          messages.push(
            seerrData.fetchedRealtime
              ? "Seerr (real-time)"
              : "Seerr"
          );
        } else {
          messages.push("Seerr ❌");
        }

        // Show combined status
        if (successCount === 2) {
          showToast(`✅ Users refreshed: ${messages.join(", ")}`);
        } else if (successCount === 1) {
          showToast(`⚠️ Partial refresh: ${messages.join(", ")}`);
        } else {
          throw new Error("Failed to refresh users");
        }
      } catch (error) {
        console.error("Refresh users error:", error);
        showToast("Failed to refresh users. Check connections.");
      } finally {
        refreshAllUsersBtn.disabled = false;
        refreshAllUsersBtn.innerHTML = originalHtml;
      }
    });
  }

  // Lazy load members/users when user clicks on the dropdowns
  const discordSelect = document.getElementById("discord-user-select");
  const seerrSelect = document.getElementById("seerr-user-select");

  if (discordSelect) {
    const trigger = discordSelect.querySelector(".custom-select-trigger");
    const chevron = discordSelect.querySelector(".custom-select-chevron");

    // Click on wrapper or trigger to open
    discordSelect.addEventListener("click", (e) => {
      // Don't open if clicking on an option
      if (e.target.closest(".custom-select-option")) return;

      const wasActive = discordSelect.classList.contains("active");
      const hasSelection = discordSelect.classList.contains("has-selection");

      // Close all other custom selects
      document.querySelectorAll(".custom-select.active").forEach((el) => {
        if (el !== discordSelect) {
          el.classList.remove("active");
        }
      });

      if (!wasActive) {
        // Load members if not loaded
        if (!membersLoaded) {
          loadDiscordMembers();
        }

        // If user was selected, restore search mode
        if (hasSelection) {
          const display = discordSelect.querySelector(".custom-select-display");
          if (display) display.style.display = "none";
          trigger.style.display = "block";
          trigger.value = "";
        }

        discordSelect.classList.add("active");
        trigger.removeAttribute("readonly");
        trigger.focus();
      } else {
        discordSelect.classList.remove("active");

        // If has selection, restore display mode
        if (hasSelection) {
          const display = discordSelect.querySelector(".custom-select-display");
          if (display) display.style.display = "flex";
          trigger.style.display = "none";
        } else {
          trigger.setAttribute("readonly", "");
        }
        trigger.blur();
      }
    });

    // Search functionality
    trigger.addEventListener("input", (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const options = discordSelect.querySelectorAll(".custom-select-option");

      options.forEach((option) => {
        const displayName = option.dataset.displayName.toLowerCase();
        const username = option.dataset.username.toLowerCase();

        if (displayName.includes(searchTerm) || username.includes(searchTerm)) {
          option.style.display = "flex";
        } else {
          option.style.display = "none";
        }
      });
    });
  }

  function restoreDiscordTrigger() {
    const discordSelect = document.getElementById("discord-user-select");
    const trigger = discordSelect.querySelector(".custom-select-trigger");
    const selectedValue = discordSelect.dataset.value;

    if (selectedValue) {
      const member = discordMembers.find((m) => m.id === selectedValue);
      if (member) {
        // Build trigger content via DOM APIs
        while (trigger.firstChild) {
          trigger.removeChild(trigger.firstChild);
        }
        const triggerContent = document.createElement("div");
        triggerContent.className = "custom-select-trigger-content";
        const img = document.createElement("img");
        img.alt = member.displayName || "";
        if (isSafeAvatarUrl(member.avatar)) {
          img.src = member.avatar;
        }
        const span = document.createElement("span");
        span.textContent = `${member.displayName} (@${member.username})`;
        triggerContent.appendChild(img);
        triggerContent.appendChild(span);
        const chevron = document.createElement("i");
        chevron.classList.add("bi", "bi-chevron-down");
        trigger.appendChild(triggerContent);
        trigger.appendChild(chevron);
        return;
      }
    }

    trigger.innerHTML = `
      <span>Select a Discord user...</span>
      <i class="bi bi-chevron-down"></i>
    `;
  }

  if (seerrSelect) {
    const trigger = seerrSelect.querySelector(".custom-select-trigger");
    const chevron = seerrSelect.querySelector(".custom-select-chevron");

    // Click on wrapper or trigger to open
    seerrSelect.addEventListener("click", (e) => {
      // Don't open if clicking on an option
      if (e.target.closest(".custom-select-option")) return;

      const wasActive = seerrSelect.classList.contains("active");
      const hasSelection = seerrSelect.classList.contains("has-selection");

      // Close all other custom selects
      document.querySelectorAll(".custom-select.active").forEach((el) => {
        if (el !== seerrSelect) {
          el.classList.remove("active");
        }
      });

      if (!wasActive) {
        // Load users if not loaded
        if (!usersLoaded) {
          loadSeerrUsers();
        }

        // If user was selected, restore search mode
        if (hasSelection) {
          const display = seerrSelect.querySelector(
            ".custom-select-display"
          );
          if (display) display.style.display = "none";
          trigger.style.display = "block";
          trigger.value = "";
        }

        seerrSelect.classList.add("active");
        trigger.removeAttribute("readonly");
        trigger.focus();
      } else {
        seerrSelect.classList.remove("active");

        // If has selection, restore display mode
        if (hasSelection) {
          const display = seerrSelect.querySelector(
            ".custom-select-display"
          );
          if (display) display.style.display = "flex";
          trigger.style.display = "none";
        } else {
          trigger.setAttribute("readonly", "");
        }
        trigger.blur();
      }
    });

    // Search functionality
    trigger.addEventListener("input", (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const options = seerrSelect.querySelectorAll(
        ".custom-select-option"
      );

      options.forEach((option) => {
        const displayName = option.dataset.displayName.toLowerCase();
        const email = (option.dataset.email || "").toLowerCase();

        if (displayName.includes(searchTerm) || email.includes(searchTerm)) {
          option.style.display = "flex";
        } else {
          option.style.display = "none";
        }
      });
    });
  }

  function restoreSeerrTrigger() {
    const seerrSelect = document.getElementById("seerr-user-select");
    const trigger = seerrSelect.querySelector(".custom-select-trigger");
    const selectedValue = seerrSelect.dataset.value;

    if (selectedValue) {
      const user = seerrUsers.find(
        (u) => String(u.id) === String(selectedValue)
      );
      if (user) {
        trigger.innerHTML = `
          <div class="custom-select-trigger-content">
            <span>${escapeHtml(user.displayName)}${
          user.email ? ` (${escapeHtml(user.email)})` : ""
        }</span>
          </div>
          <i class="bi bi-chevron-down"></i>
        `;
        return;
      }
    }

    trigger.innerHTML = `
      <span>Select a Seerr user...</span>
      <i class="bi bi-chevron-down"></i>
    `;
  }

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-select")) {
      document.querySelectorAll(".custom-select.active").forEach((el) => {
        el.classList.remove("active");
        const trigger = el.querySelector(".custom-select-trigger");
        const hasSelection = el.classList.contains("has-selection");

        if (trigger) {
          trigger.setAttribute("readonly", "");
          trigger.blur();

          // If has selection, restore display mode
          if (hasSelection) {
            const display = el.querySelector(".custom-select-display");
            if (display) display.style.display = "flex";
            trigger.style.display = "none";
            trigger.value = "";
          }
        }
      });
    }
  });

  // --- Role Permissions ---
  let rolesLoaded = false;
  let guildRoles = [];

  async function loadRoles() {
    if (rolesLoaded && guildRoles.length > 0) {
      return;
    }

    try {
      const response = await fetch("/api/discord-roles");
      const data = await response.json();

      if (data.success && data.roles) {
        guildRoles = data.roles;
        rolesLoaded = true;

        // Load current config to get saved allowlist/blocklist
        const configResponse = await fetch("/api/config");
        const config = await configResponse.json();
        const allowlist = config.ROLE_ALLOWLIST || [];
        const blocklist = config.ROLE_BLOCKLIST || [];

        populateRoleList("allowlist-roles", allowlist);
        populateRoleList("blocklist-roles", blocklist);
      } else {
        document.getElementById("allowlist-roles").innerHTML =
          `<p class="form-text" style="opacity: 0.7; font-style: italic;">${t('errors.bot_must_be_running')}</p>`;
        document.getElementById("blocklist-roles").innerHTML =
          `<p class="form-text" style="opacity: 0.7; font-style: italic;">${t('errors.bot_must_be_running')}</p>`;
      }
    } catch (error) {}
  }

  function populateRoleList(containerId, selectedRoles) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (guildRoles.length === 0) {
      container.innerHTML =
        `<p class="form-text" style="opacity: 0.7; font-style: italic;">${t('errors.no_roles_available')}</p>`;
      return;
    }

    container.innerHTML = guildRoles
      .map((role) => {
        const isChecked = selectedRoles.includes(role.id);
        const listType = containerId.includes("allowlist")
          ? "allowlist"
          : "blocklist";
        const roleColor =
          role.color && role.color !== "#000000" ? role.color : "#b8bdc2";

        return `
        <label class="role-item">
          <input type="checkbox"
                 name="${
                   listType === "allowlist"
                     ? "ROLE_ALLOWLIST"
                     : "ROLE_BLOCKLIST"
                 }"
                 value="${role.id}"
                 ${isChecked ? "checked" : ""}>
          <div class="role-color-indicator" style="background-color: ${roleColor};"></div>
          <span class="role-name">${escapeHtml(role.name)}</span>
          <span class="role-member-count">${
            role.memberCount || 0
          } members</span>
        </label>
      `;
      })
      .join("");
  }

  // --- LOGS PAGE FUNCTIONALITY ---
  const logsPageBtn = document.getElementById("logs-page-btn");
  const logsSection = document.getElementById("logs-section");
  const setupSection = document.getElementById("setup");
  const logsContainer = document.getElementById("logs-container");
  const logsTabBtns = document.querySelectorAll(".logs-tab-btn");
  const botControlBtnLogs = document.getElementById("bot-control-btn-logs");
  const botControlTextLogs = document.getElementById("bot-control-text-logs");
  let currentLogsTab = "all";

  // Track if we're on logs page for polling
  let logsPageActive = false;
  let logsPollingInterval = null;

  // Logs page button click handler
  logsPageBtn.addEventListener("click", async () => {
    setupSection.style.display = "none";
    logsSection.style.display = "flex";

    // Hide only hero and footer, keep navbar
    document.querySelector(".hero").style.display = "none";
    document.querySelector(".footer").style.display = "none";

    logsPageActive = true;

    window.scrollTo(0, 0);
    await loadLogs(currentLogsTab);
    await updateConnectionStatus();
    await updateBotControlButtonLogs();

    // Start polling for status updates
    if (logsPollingInterval) {
      clearInterval(logsPollingInterval);
    }
    logsPollingInterval = setInterval(async () => {
      if (logsPageActive) {
        await updateBotControlButtonLogs();
      }
    }, 10000); // Poll every 10 seconds
  });

  // Logs tab switching
  logsTabBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      // Skip if this is the refresh button
      if (btn.id === "refresh-logs-btn") {
        return;
      }

      logsTabBtns.forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      currentLogsTab = btn.dataset.target;
      await loadLogs(currentLogsTab);
    });
  });

  // Refresh logs button
  const refreshLogsBtn = document.getElementById("refresh-logs-btn");
  if (refreshLogsBtn) {
    refreshLogsBtn.addEventListener("click", async () => {
      const icon = refreshLogsBtn.querySelector("i");
      icon.style.animation = "spin 0.5s linear";
      await loadLogs(currentLogsTab);
      setTimeout(() => {
        icon.style.animation = "";
      }, 500);
    });
  }

  // Load and display logs
  async function loadLogs(type) {
    try {
      logsContainer.innerHTML =
        '<div style="text-align: center; color: var(--subtext0); padding: 2rem;">Loading logs...</div>';
      const endpoint = type === "error" ? "/api/logs/error" : "/api/logs/all";
      const response = await fetch(endpoint);
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();

      if (data.entries.length === 0) {
        const emptyMessage =
          type === "error" ? "No errors found" : "No logs available";
        logsContainer.innerHTML = `<div class="logs-empty">${emptyMessage}</div>`;
        return;
      }

      // Build log entries HTML
      const logsHtml = data.entries
        .map(
          (entry) => `
        <div class="log-entry">
          <span class="log-timestamp">${entry.timestamp}</span>
          <span class="log-level ${
            entry.level
          }">${entry.level.toUpperCase()}</span>
          <span class="log-message">${escapeHtml(entry.message)}</span>
        </div>
      `
        )
        .join("");

      // Add truncation notice if needed
      let truncationNotice = "";
      if (data.truncated) {
        truncationNotice = `<div style="padding: 1rem; background-color: var(--surface1); border-bottom: 1px solid var(--border); text-align: center; color: var(--text); font-size: 0.9rem;">
          <i class="bi bi-info-circle" style="margin-right: 0.5rem;"></i>Showing last 1,000 entries. Older logs are archived for space efficiency.
        </div>`;
      }

      logsContainer.innerHTML = truncationNotice + logsHtml;
    } catch (error) {
      logsContainer.innerHTML = `<div class="logs-empty">${t('errors.loading_logs')}: ${escapeHtml(error.message)}</div>`;
    }
  }

  // Helper function to escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Update connection status indicators
  async function updateConnectionStatus() {
    const seerrIndicator = document.getElementById(
      "seerr-status-indicator"
    );
    const jellyfinIndicator = document.getElementById(
      "jellyfin-status-indicator"
    );

    if (!seerrIndicator || !jellyfinIndicator) {
      return; // Not on logs page
    }

    // Set to checking state
    seerrIndicator.className = "status-dot status-checking";
    jellyfinIndicator.className = "status-dot status-checking";

    // Test Seerr - get current config values
    try {
      const configResponse = await fetch("/api/config");
      const config = await configResponse.json();

      const seerrUrl = config.SEERR_URL;
      const seerrApiKey = config.SEERR_API_KEY;

      if (!seerrUrl || !seerrApiKey) {
        seerrIndicator.className = "status-dot status-disconnected";
      } else {
        const seerrResponse = await fetch("/api/test-seerr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: seerrUrl,
            apiKey: seerrApiKey,
          }),
        });

        if (seerrResponse.ok) {
          seerrIndicator.className = "status-dot status-connected";
        } else {
          seerrIndicator.className = "status-dot status-disconnected";
        }
      }
    } catch (error) {
      seerrIndicator.className = "status-dot status-disconnected";
    }

    // Test Jellyfin - get current config values
    try {
      const configResponse = await fetch("/api/config");
      const config = await configResponse.json();

      const jellyfinUrl = config.JELLYFIN_BASE_URL;
      const jellyfinApiKey = config.JELLYFIN_API_KEY;

      if (!jellyfinUrl || !jellyfinApiKey) {
        jellyfinIndicator.className = "status-dot status-disconnected";
      } else {
        const jellyfinResponse = await fetch("/api/test-jellyfin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: jellyfinUrl, apiKey: jellyfinApiKey }),
        });

        if (jellyfinResponse.ok) {
          jellyfinIndicator.className = "status-dot status-connected";
        } else {
          jellyfinIndicator.className = "status-dot status-disconnected";
        }
      }
    } catch (error) {
      jellyfinIndicator.className = "status-dot status-disconnected";
    }
  }

  // Update bot control button for logs page
  async function updateBotControlButtonLogs() {
    try {
      const response = await fetch("/api/status");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const status = await response.json();

      const isRunning = status.isBotRunning;

      if (isRunning) {
        botControlBtnLogs.classList.remove("btn-success");
        botControlBtnLogs.classList.add("btn-danger");
        botControlBtnLogs.querySelector("i").className = "bi bi-pause-fill";
        botControlTextLogs.textContent = "Stop Bot";
      } else {
        botControlBtnLogs.classList.remove("btn-danger");
        botControlBtnLogs.classList.add("btn-success");
        botControlBtnLogs.querySelector("i").className = "bi bi-play-fill";
        botControlTextLogs.textContent = "Start Bot";
      }
    } catch (error) {}
  }

  // Bot control button for logs page
  botControlBtnLogs.addEventListener("click", async () => {
    try {
      // Get current status first
      const statusResponse = await fetch("/api/status");
      const statusData = await statusResponse.json();
      const isRunning = statusData.isBotRunning;

      const endpoint = isRunning ? "/api/stop-bot" : "/api/start-bot";

      botControlBtnLogs.disabled = true;
      const originalText = botControlTextLogs.textContent;
      botControlTextLogs.textContent = "Processing...";

      const response = await fetch(endpoint, { method: "POST" });

      if (!response.ok) {
        const data = await response.json();
        showToast(`Error: ${data.message}`);
        botControlTextLogs.textContent = originalText;
        botControlBtnLogs.disabled = false;
      } else {
        const data = await response.json();
        showToast(data.message);
        setTimeout(async () => {
          await updateBotControlButtonLogs();
          await fetchStatus(); // Update main page button too
          botControlBtnLogs.disabled = false;
        }, 1000);
      }
    } catch (error) {
      showToast(`Failed to control bot.`);
      botControlBtnLogs.disabled = false;
    }
  });

  // Back to configuration button handler
  const backToConfigBtn = document.getElementById("back-to-config-btn");
  backToConfigBtn.addEventListener("click", (e) => {
    e.preventDefault();
    logsSection.style.display = "none";
    setupSection.style.display = "block";

    // Show hero and footer again
    document.querySelector(".hero").style.display = "block";
    document.querySelector(".footer").style.display = "block";

    logsPageActive = false;

    // Stop polling
    if (logsPollingInterval) {
      clearInterval(logsPollingInterval);
      logsPollingInterval = null;
    }

    window.scrollTo(0, 0);
  });

  // Back to setup button (reuse nav items logic for logs section)
  document
    .querySelectorAll(".nav-item, .about-button, .about-link")
    .forEach((item) => {
      item.addEventListener("click", (e) => {
        if (logsSection.style.display !== "none") {
          e.preventDefault();
          logsSection.style.display = "none";
          setupSection.style.display = "block";
          window.scrollTo(0, 0);
        }
      });
    });

  // --- Hide/Show Header Functionality ---
  const hideHeaderBtn = document.getElementById("hide-header-btn");
  const showHeaderBtn = document.getElementById("show-header-btn");
  const HEADER_VISIBILITY_KEY = "anchorr_header_visible";

  // Load header visibility state from localStorage
  function loadHeaderVisibilityState() {
    const stored = localStorage.getItem(HEADER_VISIBILITY_KEY);
    if (stored === null) {
      return true; // Default to visible
    }
    return stored === "true";
  }

  // Save header visibility state to localStorage
  function saveHeaderVisibilityState(isVisible) {
    localStorage.setItem(HEADER_VISIBILITY_KEY, isVisible ? "true" : "false");
    // Also save to config.json
    saveHeaderVisibilityToConfig(isVisible);
  }

  // Save to config.json on server
  async function saveHeaderVisibilityToConfig(isVisible) {
    try {
      // Create minimal config update with just HEADER_VISIBLE
      const updateData = {
        HEADER_VISIBLE: isVisible ? "true" : "false",
      };

      await fetch("/api/save-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updateData),
      });
    } catch (error) {
      // Silent fail - localStorage is enough for UI state
    }
  }

  // Hide header with animation
  // Hide header with animation
  function hideHeader() {
    mainHero.classList.add("collapsed");
    hideHeaderBtn.classList.remove("visible");
    showHeaderBtn.classList.add("visible");
    // Ensure visibility regardless of CSS parsing
    if (showHeaderBtn) showHeaderBtn.style.display = "flex";
    saveHeaderVisibilityState(false);
  }

  // Show header with animation
  function showHeader() {
    mainHero.classList.remove("collapsed");
    showHeaderBtn.classList.remove("visible");
    hideHeaderBtn.classList.add("visible");
    if (showHeaderBtn) showHeaderBtn.style.display = "none";
    saveHeaderVisibilityState(true);
  }

  // Event listeners for hide/show buttons
  if (hideHeaderBtn) {
    hideHeaderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideHeader();
    });
  }

  if (showHeaderBtn) {
    showHeaderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showHeader();
    });
  }

  // Initialize header visibility state on page load
  function initializeHeaderVisibility() {
    // Skip if on auth page (hero is full-screen during auth)
    if (document.body.classList.contains("auth-mode")) {
      return;
    }

    const isVisible = loadHeaderVisibilityState();
    if (!isVisible) {
      // Apply collapsed state without animation on page load
      mainHero.classList.add("collapsed");
      hideHeaderBtn.classList.remove("visible");
      showHeaderBtn.classList.add("visible");
      if (showHeaderBtn) showHeaderBtn.style.display = "flex";
    } else {
      mainHero.classList.remove("collapsed");
      hideHeaderBtn.classList.add("visible");
      showHeaderBtn.classList.remove("visible");
      if (showHeaderBtn) showHeaderBtn.style.display = "none";
    }

    // Enable animations after initialization
    mainHero.classList.remove("no-animate");
  }

  // Call initialization after auth check completes
  // We need to wait a bit for checkAuth to complete
  setTimeout(() => {
    initializeHeaderVisibility();
  }, 100);
});
