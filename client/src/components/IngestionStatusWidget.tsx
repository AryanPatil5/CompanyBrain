import { useState, useEffect } from 'react';
import { Play, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { triggerIngestion, getIngestionJobStatus, type IngestionJobStatusResponse } from '../services/apiClient';

export function IngestionStatusWidget() {
  const [loading, setLoading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<IngestionJobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunIngestion = async (jobName: string = 'all') => {
    setLoading(true);
    setError(null);
    try {
      const res = await triggerIngestion(jobName);
      if (res.jobId) {
        setActiveJobId(res.jobId);
        setJobStatus({
          jobId: res.jobId,
          name: jobName,
          status: 'queued',
          progress: 10,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to queue ingestion job.');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(async () => {
      try {
        const statusData = await getIngestionJobStatus(activeJobId);
        setJobStatus(statusData);

        if (statusData.status === 'completed' || statusData.status === 'failed') {
          setLoading(false);
          clearInterval(interval);
        }
      } catch {
        // Fallback polling catch
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeJobId]);

  return (
    <div className="glass-panel rounded-2xl p-5 border border-black/[0.08] space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[16px] font-semibold text-[#1d1d1f]">Async Ingestion Queue (BullMQ)</h3>
          <p className="text-[12.5px] text-[#6e6e73]">Trigger background crawler sweeps across Slack, GitHub, Linear, Zendesk, and DB logs.</p>
        </div>
        <button
          type="button"
          onClick={() => handleRunIngestion('all')}
          disabled={loading}
          className="specular flex h-10 items-center gap-2 rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-4 text-[13px] font-medium text-white shadow-[0_2px_10px_rgba(0,113,227,0.25)] transition-transform active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Knowledge Crawl
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[12.5px] text-red-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {jobStatus && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-[12px] font-medium">
            <span className="text-slate-700 font-mono">Job ID: {jobStatus.jobId}</span>
            <span className="flex items-center gap-1.5 capitalize text-slate-800">
              {jobStatus.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
              {jobStatus.status === 'queued' && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />}
              Status: <span className="font-semibold">{jobStatus.status}</span>
            </span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-[#0071e3] transition-all duration-300"
              style={{ width: `${Math.max(jobStatus.progress || 10, 10)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
