import { SettingsStub } from "@/components/settings/settings-stub";
import { Waves } from "lucide-react";
export default function Page() {
    return <SettingsStub title="Sound Editor" description="Buffer size, sample rate, plugin chain implicit." Icon={Waves} />;
}
