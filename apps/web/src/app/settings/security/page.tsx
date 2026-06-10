import { SettingsStub } from "@/components/settings/settings-stub";
import { ShieldCheck } from "lucide-react";
export default function Page() {
    return <SettingsStub title="Securitate" description="Passkeys, sesiuni active, 2FA, log securitate." Icon={ShieldCheck} />;
}
