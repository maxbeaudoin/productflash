import { createFileRoute } from "@tanstack/react-router";
import { AudienceSection } from "~/components/landing/AudienceSection";
import { CTASection } from "~/components/landing/CTASection";
import { DigestPreview } from "~/components/landing/DigestPreview";
import { Footer } from "~/components/landing/Footer";
import { Hero } from "~/components/landing/Hero";
import { ProblemSection } from "~/components/landing/ProblemSection";
import { ProofSection } from "~/components/landing/ProofSection";
import { SolutionSection } from "~/components/landing/SolutionSection";
import { TopBar } from "~/components/landing/TopBar";

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
