import GlassFilter from "@/components/GlassFilter";
import GlyphBackground from "@/components/GlyphBackground";
import Nav from "@/components/Nav";
import TweaksPanel from "@/components/TweaksPanel";
import { MusicProvider } from "@/lib/music";
import { TweaksProvider } from "@/lib/tweaks";

// The background, navigation and download state live in this layout, so they keep
// running while you move between Home, Downloads, History and Settings.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <TweaksProvider>
      <MusicProvider>
        <GlassFilter />
        <GlyphBackground />
        <Nav />
        <main className="relative z-10 mx-auto w-full max-w-[1120px] px-4 pb-32 pt-24 sm:px-6 sm:pt-28">{children}</main>
        <TweaksPanel />
      </MusicProvider>
    </TweaksProvider>
  );
}
