import { useState } from "react";
import { X, Sparkles, Plus, Trash2, UserCheck } from "lucide-react";
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
  const handleRemoveStep = (idx: number) => setSteps((prev) => prev.filter((_, i) => i !== idx));
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
        className="absolute inset-0 bg-black/60 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] duration-500 ease-out animate-in fade-in zoom-in-95">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 p-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-indigo/30 bg-indigo/10 text-indigo">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] font-medium tracking-wide text-indigo uppercase">
                Tacit Knowledge Capture
              </span>
            </div>
            <h2 className="text-[21px] font-semibold tracking-tight">Teach Company Brain</h2>
            <p className="text-[12.5px] text-muted-foreground">
              Directly contribute unwritten operational procedures, decision rules, and tacit domain know-how.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="glass-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-4 overflow-y-auto p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-[11.5px] font-medium text-muted-foreground uppercase">
                  SOP / Scenario Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Legacy Customer Refund Exception Protocol"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-indigo"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11.5px] font-medium text-muted-foreground uppercase">
                  Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-black/40 px-3.5 py-2.5 text-[13.5px] outline-none focus:border-indigo"
                >
                  <option value="Engineering">Engineering</option>
                  <option value="Support">Support</option>
                  <option value="Billing">Billing</option>
                  <option value="Operations">Operations</option>
                  <option value="Security">Security</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11.5px] font-medium text-muted-foreground uppercase">
                Your Name / Role (Domain Expert)
              </label>
              <input
                type="text"
                placeholder="e.g. Sarah Jenkins (Head of Ops)"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-indigo"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11.5px] font-medium text-muted-foreground uppercase">
                Scenario & Trigger Description *
              </label>
              <textarea
                required
                rows={3}
                placeholder="Describe when this procedure applies and what rules govern it..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-xl border border-white/12 bg-white/[0.04] p-3 text-[13.5px] outline-none focus:border-indigo"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11.5px] font-medium text-muted-foreground uppercase">
                  Execution Steps (Optional)
                </label>
                <button
                  type="button"
                  onClick={handleAddStep}
                  className="flex items-center gap-1 text-[12px] font-medium text-cyan hover:underline"
                >
                  <Plus className="h-3 w-3" /> Add Step
                </button>
              </div>
              {steps.map((step, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-[11px]">
                    {idx + 1}
                  </span>
                  <input
                    type="text"
                    placeholder={`Step ${idx + 1} action (e.g. Verify account tier in Postgres)`}
                    value={step}
                    onChange={(e) => handleStepChange(idx, e.target.value)}
                    className="flex-1 rounded-xl border border-white/12 bg-white/[0.04] px-3.5 py-2 text-[13px] outline-none focus:border-indigo"
                  />
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveStep(idx)}
                      className="glass-button flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-white/10 p-5">
            <button
              type="button"
              onClick={onClose}
              className="glass-button rounded-full px-5 py-2.5 text-[13px] font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title || !description}
              className="specular relative flex items-center gap-2 overflow-hidden rounded-full border border-white/20 bg-gradient-to-b from-indigo to-primary px-5 py-2.5 text-[13px] font-medium text-primary-foreground shadow-[0_0_30px_-6px_var(--indigo)] disabled:opacity-50"
            >
              <UserCheck className="h-4 w-4" />
              {loading ? "Extracting & Indexing..." : "Synthesize into SOP Draft"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
