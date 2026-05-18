import { createFileRoute } from "@tanstack/react-router";
import { AudienceSection } from "~/features/landing/ui/AudienceSection";
import { CTASection } from "~/features/landing/ui/CTASection";
import { DigestPreview } from "~/features/landing/ui/DigestPreview";
import { Footer } from "~/features/landing/ui/Footer";
import { Hero } from "~/features/landing/ui/Hero";
import { ProblemSection } from "~/features/landing/ui/ProblemSection";
import { ProofSection } from "~/features/landing/ui/ProofSection";
import { SolutionSection } from "~/features/landing/ui/SolutionSection";
import { TopBar } from "~/features/landing/ui/TopBar";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

function LandingPage() {
  return (
    <main className="scroll-smooth bg-paper text-text antialiased">
      <TopBar />
      <Hero />
      <ProblemSection />
      <SolutionSection />
      <DigestPreview />
      <AudienceSection />
      <ProofSection />
      <CTASection />
      <Footer />
    </main>
  );
}
