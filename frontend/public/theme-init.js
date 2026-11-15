// Apply the saved theme before the first paint (see src/lib/theme.tsx). A file, not an
// inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  var flavors = ["latte", "frappe", "macchiato", "mocha"];
  var f = localStorage.getItem("anchorr.flavor");
  if (flavors.indexOf(f) < 0) f = "macchiato";
  var a = localStorage.getItem("anchorr.accent") || "mauve";
  var r = document.documentElement;
  r.dataset.flavor = f;
  r.dataset.accent = a;
  r.classList.toggle("dark", f !== "latte");
} catch (e) {}
