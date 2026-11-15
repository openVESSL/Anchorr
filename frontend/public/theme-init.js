// Apply the saved theme before the first paint (see src/lib/theme.tsx). A file, not an
// inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  var f = localStorage.getItem("anchorr.flavor") || "auto";
  var a = localStorage.getItem("anchorr.accent") || "mauve";
  if (f === "auto") f = matchMedia("(prefers-color-scheme: dark)").matches ? "mocha" : "latte";
  var r = document.documentElement;
  r.dataset.flavor = f;
  r.dataset.accent = a;
  r.classList.toggle("dark", f !== "latte");
} catch (e) {}
