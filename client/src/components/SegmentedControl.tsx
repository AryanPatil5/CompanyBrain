import { SOP_CATEGORIES } from "@/lib/sops";

export function SegmentedControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-full border border-black/[0.06] bg-black/[0.04] p-1.5 backdrop-blur-xl">
      {SOP_CATEGORIES.map((cat) => {
        const active = cat === value;
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onChange(cat)}
            className={[
              "rounded-full px-4 py-1.5 text-[13px] transition-all duration-300 ease-[cubic-bezier(0.22,1.2,0.36,1)]",
              active
                ? "bg-white font-semibold text-[#1d1d1f] shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
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
