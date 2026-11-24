import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#06070c",
        ink: "#e8ebf7",
        accent: "#7aa2ff",
        ok: "#1DB954",
        err: "#ff6464",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: { glass: "var(--radius)" },
    },
  },
  plugins: [],
};

export default config;
