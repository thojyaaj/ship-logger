import { pageRequireAdmin } from "@/lib/auth";
import { getDailyVolume } from "@/lib/shiplog";
import VolumeChart from "../shipments/VolumeChart";

export default async function AnalyticsPage() {
  await pageRequireAdmin();
  const dailyVolume = await getDailyVolume(30);

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Analytics</h1>
      </div>

      <VolumeChart points={dailyVolume} />
    </div>
  );
}
