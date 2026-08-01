import { SOP_CATEGORIES } from "@/lib/sops";

export function SegmentedControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-2xl border border-black/[0.06] bg-black/[0.04] p-1.5 backdrop-blur-xl">
      {SOP_CATEGORIES.map((cat) => {
        const active = cat === value;
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onChange(cat)}
            className={[
              "h-9 overflow-hidden rounded-xl px-4 text-[13px] font-medium transition-all duration-200 ease-[cubic-bezier(0.22,1.2,0.36,1)] active:scale-95",
              active
                ? "glass-lens font-semibold text-[#1d1d1f]"
                : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-white/40",
            ].join(" ")}
          >
            {cat}
          </button>
        );
      })}
    </div>
  );
}
