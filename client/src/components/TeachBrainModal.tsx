import { useState } from "react";
import {
  X,
  Sparkles,
  Plus,
  Trash2,
  UserCheck,
  ChevronDown,
} from "lucide-react";
import { teachBrainApi } from "@/lib/sops";

export function TeachBrainModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Operations");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleAddStep = () => setSteps((prev) => [...prev, ""]);
  const handleRemoveStep = (idx: number) =>
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  const handleStepChange = (idx: number, val: string) => {
    setSteps((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description) return;

    setLoading(true);
    const validSteps = steps.filter((s) => s.trim().length > 0);
    const ok = await teachBrainApi({
      title,
      category,
      author: author || "Team Expert",
      description,
      steps: validSteps,
    });
    setLoading(false);

    if (ok) {
      setTitle("");
      setDescription("");
      setSteps([""]);
      onSuccess();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/25 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl duration-300 ease-out animate-in fade-in zoom-in-95 shadow-[0_16px_50px_rgba(0,0,0,0.1)]">
        <header className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[#0071e3]">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide text-[#0071e3] uppercase">
                Tacit Knowledge Capture
              </span>
            </div>
            <h2 className="text-[21px] font-semibold tracking-tight text-[#1d1d1f]">
              Teach Company Brain
            </h2>
            <p className="text-[12.5px] text-[#6e6e73]">
              Directly contribute unwritten operational procedures, decision
              rules, and tacit domain know-how.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="glass-button flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[#6e6e73] hover:text-[#1d1d1f] active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <form
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex-1 space-y-4 overflow-y-auto p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                  SOP / Scenario Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Legacy Customer Refund Exception Protocol"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full h-11 rounded-2xl border border-black/10 bg-white/80 px-4 text-[13.5px] text-[#1d1d1f] shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-colors focus:border-[#0071e3] focus:bg-white focus:ring-2 focus:ring-[#0071e3]/20"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                  Category
                </label>
                <div className="relative">
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full h-11 appearance-none rounded-2xl border border-black/10 bg-white/80 px-4 pr-10 text-[13.5px] text-[#1d1d1f] shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-colors focus:border-[#0071e3] focus:bg-white focus:ring-2 focus:ring-[#0071e3]/20 cursor-pointer"
                  >
                    <option value="Engineering">Engineering</option>
                    <option value="Support">Support</option>
                    <option value="Billing">Billing</option>
                    <option value="Operations">Operations</option>
                    <option value="Security">Security</option>
                  </select>
                  <ChevronDown className="absolute right-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6e6e73] pointer-events-none" />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                Your Name / Role (Domain Expert)
              </label>
              <input
                type="text"
                placeholder="e.g. Sarah Jenkins (Head of Ops)"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="w-full h-11 rounded-2xl border border-black/10 bg-white/80 px-4 text-[13.5px] text-[#1d1d1f] shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-colors focus:border-[#0071e3] focus:bg-white focus:ring-2 focus:ring-[#0071e3]/20"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                Scenario & Trigger Description *
              </label>
              <textarea
                required
                rows={3}
                placeholder="Describe when this procedure applies and what rules govern it..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-2xl border border-black/10 bg-white/80 p-3.5 text-[13.5px] text-[#1d1d1f] shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-colors focus:border-[#0071e3] focus:bg-white focus:ring-2 focus:ring-[#0071e3]/20"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                  Execution Steps (Optional)
                </label>
                <button
                  type="button"
                  onClick={handleAddStep}
                  className="flex items-center gap-1 text-[12px] font-semibold text-[#0071e3] hover:underline"
                >
                  <Plus className="h-3 w-3" /> Add Step
                </button>
              </div>
              {steps.map((step, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-white font-mono text-[11px] font-semibold text-[#1d1d1f] shadow-sm">
                    {idx + 1}
                  </span>
                  <input
                    type="text"
                    placeholder={`Step ${idx + 1} action (e.g. Verify account tier in Postgres)`}
                    value={step}
                    onChange={(e) => handleStepChange(idx, e.target.value)}
                    className="flex-1 h-11 rounded-2xl border border-black/10 bg-white/80 px-4 text-[13px] text-[#1d1d1f] shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] outline-none transition-colors focus:border-[#0071e3] focus:bg-white"
                  />
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveStep(idx)}
                      className="glass-button flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[#6e6e73] hover:text-[#dc2626] active:scale-95"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-black/[0.06] p-5">
            <button
              type="button"
              onClick={onClose}
              className="glass-button flex h-11 items-center justify-center overflow-hidden rounded-lg px-6 text-[13px] font-medium active:scale-95"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title || !description}
              className="specular flex h-11 items-center gap-2 overflow-hidden rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-6 text-[13px] font-medium text-white shadow-[0_2px_10px_rgba(0,113,227,0.25)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-95 disabled:opacity-50"
            >
              <UserCheck className="h-4 w-4" />
              {loading
                ? "Extracting & Indexing..."
                : "Synthesize into SOP Draft"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
