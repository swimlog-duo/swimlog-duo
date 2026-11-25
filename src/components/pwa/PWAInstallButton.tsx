import React, { useState } from 'react';
import { Download, Share, PlusSquare, X } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#0077b6] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#006094] active:scale-[0.98] whitespace-nowrap shrink-0"
      >
        <Download className="h-4 w-4" />
        <span>{compact ? 'アプリ化' : 'ホーム画面に追加'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-[#0b1f3a] transition hover:bg-slate-100 dark:border-[#2a4266] dark:bg-[#13243c] dark:text-slate-100 dark:hover:bg-[#1a304e] whitespace-nowrap shrink-0"
        >
          <Share className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          <span>{compact ? 'iPhoneに追加' : 'iPhoneホーム画面に追加'}</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-pwa-guide-title"
          >
            <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-[#1e3250] dark:bg-[#0e1b2e]">
              <div className="flex items-center justify-between gap-4">
                <h3
                  id="ios-pwa-guide-title"
                  className="text-lg font-bold text-[#0b1f3a] dark:text-slate-50"
                >
                  iPhoneホーム画面に追加
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="閉じる"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#13243c]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                Safari からホーム画面に追加すると、オフライン時でもアプリのように起動できます。
              </p>
              <ol className="mt-4 space-y-3 text-sm text-slate-800 dark:text-slate-200">
                <li className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-[#0077b6] dark:bg-[#132b4f] dark:text-[#38bdf8]">
                    1
                  </span>
                  <span>
                    画面下部（または上部）の <strong>共有</strong>{' '}
                    <Share className="inline h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" /> ボタンをタップします。
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-[#0077b6] dark:bg-[#132b4f] dark:text-[#38bdf8]">
                    2
                  </span>
                  <span>
                    メニューから <strong>ホーム画面に追加</strong>{' '}
                    <PlusSquare className="inline h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" /> を選び、右上の「追加」をタップします。
                  </span>
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full min-h-[44px] rounded-xl bg-[#0077b6] py-2.5 text-sm font-semibold text-white transition hover:bg-[#006094]"
              >
                わかりました
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
