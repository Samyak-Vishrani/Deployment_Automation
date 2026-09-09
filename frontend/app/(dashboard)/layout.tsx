import { AppShell } from "@/components/AppShell";
import { AuthGate, AuthProvider } from "@/components/AuthGate";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <AuthProvider>
      <AuthGate>
        <AppShell>{children}</AppShell>
      </AuthGate>
    </AuthProvider>
  );
}
