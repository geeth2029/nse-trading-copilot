import { useState, type FC } from 'react';
import {
  Settings,
  ShieldCheck,
  Sliders,
  Database,
  Save,
  CheckCircle2,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';

export const SettingsView: FC = () => {
  const [defaultCapital, setDefaultCapital] = useState<number>(500000);
  const [isSaved, setIsSaved] = useState(false);

  const handleSave = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-slate-400" />
            <span>Application Settings &amp; Trading Parameters</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Configure default trading capital and review non-negotiable rule boundaries.
          </p>
        </div>

        {isSaved && (
          <Badge variant="success" size="md">
            Preferences Saved!
          </Badge>
        )}
      </div>

      {/* Default Capital Configuration */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4 shadow-xl">
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Sliders className="w-4 h-4 text-cyan-400" />
          <span>User Capital Default</span>
        </h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          The base capital used for sizing initial trade entries and pyramiding steps. Risk Per Trade (RPT) is strictly fixed at 1% of this value.
        </p>

        <div className="max-w-xs space-y-1.5">
          <label className="block text-xs font-semibold text-slate-300">
            Default Trading Capital (₹)
          </label>
          <div className="relative">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400 font-mono text-xs">
              ₹
            </span>
            <input
              type="number"
              value={defaultCapital}
              onChange={(e) => setDefaultCapital(parseFloat(e.target.value) || 0)}
              className="w-full pl-8 pr-4 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none"
            />
          </div>
          <span className="text-[11px] text-cyan-400 font-mono block">
            Calculated 1% RPT: ₹{(defaultCapital * 0.01).toLocaleString('en-IN')}
          </span>
        </div>

        <div className="pt-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            icon={isSaved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          >
            {isSaved ? 'Saved' : 'Save Default'}
          </Button>
        </div>
      </div>

      {/* Confirmed Trading Rules (Read-Only Safeguards) */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Immutable Business Rules</span>
          </h3>
          <Badge variant="neutral" size="sm">
            Enforced in Core Logic
          </Badge>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          The following parameters are hard-coded in accordance with verified architecture rules and cannot be modified by user settings:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-slate-400 text-[11px] block">Risk Per Trade (RPT)</span>
            <span className="font-mono font-bold text-slate-200">1.0% of User Capital</span>
            <p className="text-[10px] text-slate-400 mt-0.5">Non-negotiable capital preservation ratio.</p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-slate-400 text-[11px] block">Weekly Momentum Filter</span>
            <span className="font-mono font-bold text-emerald-400">Weekly RSI &gt; 60.0 (Strict)</span>
            <p className="text-[10px] text-slate-400 mt-0.5">Strictly greater than 60; values of 60.0 do not qualify.</p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-slate-400 text-[11px] block">Stop-Loss Metric</span>
            <span className="font-mono font-bold text-slate-200">20-Week Completed Candle SMA</span>
            <p className="text-[10px] text-slate-400 mt-0.5">Excludes repainting from in-progress weekly candles.</p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-slate-400 text-[11px] block">Execution Boundary</span>
            <span className="font-mono font-bold text-rose-400">Zero Broker Order APIs</span>
            <p className="text-[10px] text-slate-400 mt-0.5">Decision-support &amp; paper tracking only.</p>
          </div>
        </div>
      </div>

      {/* Data Source & Legal Boundary */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 shadow-xl">
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Database className="w-4 h-4 text-cyan-400" />
          <span>Market Data &amp; Regulatory Compliance</span>
        </h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          Currently running in <strong>Demo Fixture Mode</strong>. As documented in <code>docs/data-source-research.md</code>, redistribution of exchange market data to third parties requires appropriate data licensing. No real-time exchange data is redistributed.
        </p>
      </div>
    </div>
  );
};
