import { Brain, Boxes, Network, Plug } from "lucide-react";

const NAV = [
  { label: "Skills Library", icon: Boxes },
  { label: "FastMCP Network", icon: Network },
  { label: "Integrations", icon: Plug },
];

export function GlassSidebar() {
  return (
    <aside className="glass-panel hidden w-64 shrink-0 flex-col rounded-3xl p-4 lg:flex">
      <div className="flex items-center gap-3 px-2 py-3">
        <span className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-white/15 bg-gradient-to-b from-indigo/70 to-primary/40 shadow-[0_0_26px_-4px_var(--indigo)]">
          <Brain className="h-5 w-5 text-primary-foreground" />
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight">Company Brain</p>
          <p className="text-[11px] text-muted-foreground">Knowledge Engine</p>
        </div>
      </div>

      <nav className="mt-6 flex flex-col gap-1">
        {NAV.map((item, i) => {
          const active = i === 0;
          return (
            <button
              key={item.label}
              type="button"
              className={[
                "group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-[13.5px] transition-all duration-300",
                active
                  ? "glass-button font-medium text-foreground"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              ].join(" ")}
            >
              <item.icon
                className={`h-4 w-4 ${active ? "text-indigo" : "opacity-70"}`}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Engine status
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-[13px]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald shadow-[0_0_10px_2px_var(--emerald)]" />
          Indexing nominal
        </p>
      </div>
    </aside>
  );
}
