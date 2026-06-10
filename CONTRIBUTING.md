<h1 align="center">🤝 Contributing to Anchorr</h1>

<p align="center">
  Thank you for considering contributing to Anchorr! We appreciate all kinds of contributions, from bug reports to new features.
</p>

## 🎯 Ways to Contribute

### 🐛 Report Bugs

Found a bug? Please help us fix it!

**When reporting, include:**

- Clear, descriptive title
- Steps to reproduce the issue
- Expected vs. actual behavior
- Console logs/error messages
- Your environment (Node.js version, OS, etc.)
- Screenshots if applicable

[Open a bug report](https://github.com/nairdahh/anchorr/issues/new?labels=bug&template=bug_report.md)

### 💡 Suggest Features

Have an idea to improve Anchorr?

**Before submitting:**

- Check existing issues to avoid duplicates
- Provide a clear use case
- Explain the expected behavior
- Discuss the implementation approach

[Suggest a feature](https://github.com/nairdahh/anchorr/issues/new?labels=enhancement&template=feature_request.md)

### 📝 Improve Documentation

Help us improve README, guides, or inline code comments!

### 🌐 Add Translations

Anchorr supports multiple languages! Help make it accessible to more users by contributing translations. The translation system is fully automated!

**Currently supported languages:**
- English (en) - Base language
- German (de) - Fully translated
- Swedish (sv) - Available
- French (fr) - Fully translated

#### How to Add a New Language

1. Copy `locales/template.json` to `locales/<language_code>.json` (e.g., `locales/fr.json` for French)
2. Update the `_meta` section with your language information:
```json
{
  "_meta": {
    "language_name": "Français",
    "language_code": "fr",
    "contributors": ["Your Name"],
    "completion": "0%",
    "last_updated": "2025-12-16",
    "notes": "Initial translation"
  }
}
```
3. Translate all text values (keep the keys unchanged)
4. Your translation will automatically appear in the language dropdown — no code changes needed!

#### Translation Guidelines

**Important Rules:**
- **Never change JSON keys** - only translate the values
- **Keep HTML tags intact** - e.g., `<strong>Discord</strong>` stays as `<strong>Discord</strong>`
- **Preserve placeholders** - e.g., `{{count}}` should remain `{{count}}`
- **Maintain link structure** - Keep `<a href="..." target="_blank">` tags
- **Test frequently** - Start the server and check your translation in the UI

**Language Codes (ISO 639-1):**
- `en` - English, `de` - German, `sv` - Swedish, `fr` - French, `es` - Spanish
- `es` - Spanish, `pt` - Portuguese, `pt-br` - Portuguese (Brazil)
- `zh` - Chinese, `ja` - Japanese, `ko` - Korean, `ru` - Russian, `ar` - Arabic

**Example Translation Structure:**
```json
{
  "_meta": {
    "language_name": "Français",
    "language_code": "fr",
    "contributors": ["John Doe"],
    "completion": "45%",
    "last_updated": "2025-12-16",
    "notes": "Work in progress"
  },
  "common": {
    "yes": "Oui",
    "no": "Non",
    "save": "Enregistrer",
    "cancel": "Annuler"
  },
  "config": {
    "title": "Configuration",
    "discord_instructions_1": "Allez à <strong>\"Bot\"</strong> dans la barre latérale et cliquez sur <strong>\"Add Bot\"</strong>"
  }
}
```

#### Testing Your Translation

1. Start the Anchorr server: `node app.js`
2. Open the web interface
3. Look for your language in the language dropdown
4. Select it and verify the translations appear correctly
5. Check all pages and sections

#### Submitting Your Translation

1. Fork the repository on GitHub
2. Create a branch: `git checkout -b feat/add-<language_code>-translation`
3. Add your locale file and commit:

   ```bash
   git add locales/<language_code>.json
   git commit -m "feat: add <Language Name> translation"
   ```

4. Push and [open a Pull Request](https://github.com/nairdahh/anchorr/compare) against the `main` branch

#### Common Placeholders

- `{{count}}` - Number of items
- `{{query}}` - Search query text
- `{{title}}` - Movie/show title
- `<strong>text</strong>` - Bold text
- `<code>text</code>` - Code formatting
- `<a href="...">text</a>` - Links

**Automatic Detection:**
The system automatically scans the `locales/` directory, reads the `_meta` section, populates the language dropdown, loads translations when selected, and falls back to English if translation is missing.

### 🔧 Submit Code Changes

We love pull requests! Here's how to submit one:

#### Step 1: Fork & Setup

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR-USERNAME/anchorr.git
cd anchorr
npm install
```

#### Step 2: Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or for bugfixes:
git checkout -b fix/bug-description
```

#### Step 3: Make Changes & Commit

```bash
git add .
git commit -m "feat: add awesome feature"
# Use conventional commits:
# feat: new feature
# fix: bug fix
# docs: documentation
# style: formatting changes
# refactor: code refactoring
# test: adding tests
```

#### Step 4: Push & Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then [open a PR](https://github.com/nairdahh/anchorr/compare) against the `main` branch.

#### PR Guidelines

- ✅ Keep PRs focused on a single feature/fix
- ✅ Write clear commit messages
- ✅ Update README if adding new features
- ✅ Test locally before submitting
- ✅ Link related issues

## 💬 Communication

- **Questions?** Open an issue with the `question` label
- **Discussion?** Start a GitHub Discussion
- **Need help?** Check existing documentation or issues first
