import { useState } from 'react';
import { Bot, ShieldAlert, CheckCircle2, Loader2, Play, AlertTriangle } from 'lucide-react';
import { runAgentWorkflow, type AgentWorkflowResponse } from '../services/apiClient';

export function AgentExecutionConsole() {
  const [query, setQuery] = useState('Process slow postgres query triage');
  const [loading, setLoading] = useState(false);
  const [workflow, setWorkflow] = useState<AgentWorkflowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunWorkflow = async (approvalId?: string) => {
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const res = await runAgentWorkflow(query, approvalId);
      setWorkflow(res);
    } catch (err: any) {
      setError(err.message || 'Failed to run workflow.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-5 border border-black/[0.08] space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-[#0071e3]" />
          <div>
            <h3 className="text-[16px] font-semibold text-[#1d1d1f]">Multi-Agent State Machine Execution Console</h3>
            <p className="text-[12.5px] text-[#6e6e73]">Planner DAG Decomposition → Auditor Safety Policy Check → Executor Sandbox Runner</p>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter task query..."
          className="h-10 flex-1 rounded-xl border border-black/[0.1] bg-white/70 px-3.5 text-[13px] text-[#1d1d1f] focus:border-[#0071e3] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => handleRunWorkflow()}
          disabled={loading}
          className="flex h-10 items-center gap-2 rounded-xl bg-[#0071e3] px-4 text-[13px] font-medium text-white shadow-sm hover:bg-[#0071e3]/90 active:scale-95 cursor-pointer disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Orchestrator
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12.5px] text-red-800">
          {error}
        </div>
      )}

      {workflow && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          {/* Status Header */}
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="text-[12px] font-mono text-slate-600">Workflow ID: {workflow.workflow_id}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase ${
              workflow.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
              workflow.status === 'paused_approval' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
            }`}>
              {workflow.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5" />}
              {workflow.status === 'paused_approval' && <AlertTriangle className="h-3.5 w-3.5" />}
              {workflow.status}
            </span>
          </div>

          {/* Auditor Check */}
          {workflow.audit && (
            <div className="space-y-1.5 text-[12.5px]">
              <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4 text-purple-600" />
                Auditor Risk Policy Check:
              </div>
              <div className="text-slate-600">
                Risk Level: <span className="font-semibold text-slate-800">{workflow.audit.risk_level}</span> | Approved: <span className="font-semibold">{workflow.audit.approved ? 'Yes' : 'No (Human Approval Required)'}</span>
              </div>
              {workflow.audit.flagged_reasons?.length > 0 && (
                <ul className="list-disc pl-5 text-[11.5px] text-amber-800">
                  {workflow.audit.flagged_reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Action if Paused */}
          {workflow.status === 'paused_approval' && workflow.approval_id && (
            <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900">
              <span>Approval Ticket <strong>#{workflow.approval_id}</strong> created in manager queue.</span>
              <button
                type="button"
                onClick={() => handleRunWorkflow(workflow.approval_id)}
                className="rounded-lg bg-amber-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-amber-700 active:scale-95 cursor-pointer"
              >
                Approve & Resume
              </button>
            </div>
          )}

          {/* Planner DAG Steps */}
          {workflow.plan?.steps && (
            <div className="space-y-2">
              <div className="text-[12.5px] font-semibold text-slate-800">Planner DAG Execution Steps:</div>
              <div className="space-y-2">
                {workflow.plan.steps.map((step) => {
                  const executed = workflow.executed_steps?.find((e) => e.step_id === step.id);
                  return (
                    <div key={step.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2.5 text-[12px]">
                      <div>
                        <span className="font-semibold text-slate-900">Step {step.step_number}:</span> {step.action}
                        <span className="ml-2 text-slate-500">({step.target_system})</span>
                      </div>
                      <div>
                        {executed ? (
                          <span className={`rounded px-2 py-0.5 text-[10.5px] font-semibold uppercase ${
                            executed.outcome === 'success' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {executed.outcome}
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-600 uppercase">
                            Pending
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
