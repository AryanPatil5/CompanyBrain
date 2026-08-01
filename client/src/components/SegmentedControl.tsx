import { SOP_CATEGORIES } from "@/lib/sops";

export function SegmentedControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="glass-panel inline-flex flex-wrap gap-1 rounded-full p-1">
      {SOP_CATEGORIES.map((cat) => {
        const active = cat === value;
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onChange(cat)}
            className={[
              "rounded-full px-4 py-1.5 text-[13px] transition-all duration-400 ease-[cubic-bezier(0.22,1.2,0.36,1)]",
              active
                ? "glass-button font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {cat}
          </button>
        );
      })}
    </div>
  );
}
