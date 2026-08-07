import { Brain, Boxes, Network, Plug, Sparkles } from "lucide-react";

export type NavTab = "skills" | "mcp" | "integrations" | "graph" | "agents";

const NAV: Array<{ id: NavTab; label: string; icon: any }> = [
  { id: "skills", label: "Skills Library", icon: Boxes },
  { id: "mcp", label: "FastMCP Network", icon: Network },
  { id: "integrations", label: "Integrations", icon: Plug },
];

export function GlassSidebar({
  activeTab = "skills",
  onTabChange,
  onTeachClick,
}: {
  activeTab?: NavTab;
  onTabChange?: (tab: NavTab) => void;
  onTeachClick?: () => void;
}) {
  return (
    <aside className="glass-panel hidden w-64 shrink-0 flex-col rounded-2xl p-4 lg:flex overflow-hidden">
      <div className="flex items-center gap-3 px-2 py-3">
        <span className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-[#0071e3]/20 bg-gradient-to-b from-[#0071e3] to-[#0284c7] shadow-[0_4px_14px_rgba(0,113,227,0.3)]">
          <Brain className="h-5 w-5 text-white" />
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight text-[#1d1d1f]">
            Company Brain
          </p>
          <p className="text-[11px] font-medium text-[#6e6e73]">
            Knowledge Engine
          </p>
        </div>
      </div>

      <nav className="mt-6 flex flex-col gap-1">
        {NAV.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange?.(item.id)}
              className={[
                "group flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-left text-[13.5px] transition-all duration-300 overflow-hidden cursor-pointer active:scale-95",
                active
                  ? "glass-button font-semibold text-[#0071e3] shadow-[0_2px_10px_rgba(0,113,227,0.08)]"
                  : "text-[#6e6e73] hover:bg-black/[0.04] hover:text-[#1d1d1f]",
              ].join(" ")}
            >
              <item.icon
                className={`h-4 w-4 ${active ? "text-[#0071e3]" : "opacity-70"}`}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      {onTeachClick && (
        <div className="mt-4 px-1">
          <button
            type="button"
            onClick={onTeachClick}
            className="specular flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-5 text-[13px] font-medium text-white shadow-[0_4px_14px_rgba(0,113,227,0.25)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-95 cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            Teach the Brain
          </button>
        </div>
      )}

      <div className="mt-auto rounded-2xl border border-black/[0.06] bg-white/60 p-3 shadow-sm overflow-hidden">
        <p className="text-[10px] tracking-wider font-semibold text-[#6e6e73] uppercase">
          Engine status
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-[13px] font-medium text-[#1d1d1f]">
          <span className="h-2 w-2 rounded-full bg-[#10b981] shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          Guardrails active
        </p>
      </div>
    </aside>
  );
}
