import Link from "next/link";
import { pageRequireAdmin } from "@/lib/auth";
import { getInsightHistory } from "@/lib/ai-insights";
import { formatDbTimestamp } from "@/lib/date";
import SimpleMarkdown from "../SimpleMarkdown";

export default async function InsightsHistoryPage() {
  await pageRequireAdmin();
  const items = await getInsightHistory();

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <div className="flex items-center gap-3">
          <h1 className="font-stencil text-2xl tracking-wide">AI Insights History</h1>
          <Link href="/analytics" className="tag-label !text-ink-faint hover:!text-ink underline">
            ← Back to Analytics
          </Link>
        </div>
        <span className="tag-label !text-ink-faint">{items.length} saved (last {items.length === 1 ? "" : "up to "}10)</span>
      </div>

      {items.length === 0 ? (
        <p className="text-ink-faint">No AI insights generated yet — click &ldquo;Generate Insights&rdquo; on the Analytics page.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <div key={item.id} className="corners bg-paper-panel p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
                <span className="tag-label !text-ink-faint">
                  {formatDbTimestamp(item.generatedAt)} · {item.windowDays}d window
                  {item.generatedByName && ` · by ${item.generatedByName}`}
                </span>
              </div>
              <div className="text-sm font-condensed">
                <SimpleMarkdown text={item.text} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
