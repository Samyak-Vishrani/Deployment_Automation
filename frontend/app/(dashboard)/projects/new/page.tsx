"use client";

import Link from "next/link";
import { ProjectOnboarding } from "@/components/ProjectOnboarding";
import { Icon } from "@/components/ui/Icon";

export default function NewProjectPage() {
  return (
    <>
      <Link href="/projects" className="back-link"><Icon name="chevron-left" size={14} /> Back to projects</Link>
      <div className="page-header"><div><p className="eyebrow">Project onboarding</p><h1>Bring a service into OrbitOps</h1><p className="page-description">Set up the source, environment, and health contract that will guide the first release.</p></div></div>
      <ProjectOnboarding />
    </>
  );
}
