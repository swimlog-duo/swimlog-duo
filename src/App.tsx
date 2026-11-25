import React from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AnalyticsPage } from './components/analytics/AnalyticsPage';
import { DisplayNameSetupScreen } from './components/auth/DisplayNameSetupScreen';
import { LoginScreen } from './components/auth/LoginScreen';
import { HomePage } from './components/home/HomePage';
import { AppShell } from './components/layout/AppShell';
import { PracticeLogDetailPage } from './components/logs/PracticeLogDetailPage';
import { PracticeLogEditorPage } from './components/logs/PracticeLogEditorPage';
import { PracticeLogListPage } from './components/logs/PracticeLogListPage';
import { MenuDetailPrintPage } from './components/menus/MenuDetailPrintPage';
import { MenuEditorPage } from './components/menus/MenuEditorPage';
import { MenuListPage } from './components/menus/MenuListPage';
import { OfflineSyncBanner } from './components/pwa/OfflineSyncBanner';
import { SettingsPage } from './components/settings/SettingsPage';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { SwimDataProvider } from './hooks/useSwimData';
import { useTheme } from './hooks/useTheme';
import { isDisplayNameEmpty } from './utils/displayName';

const AuthenticatedApp: React.FC = () => {
  const { session, isLoading } = useAuth();
  useTheme();

  if (isLoading && !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f7fb] text-sm text-[#0b1f3a] dark:bg-[#07111e] dark:text-slate-200">
        認証状態とオフラインデータを確認中...
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  if (isDisplayNameEmpty(session.displayName)) {
    return <DisplayNameSetupScreen />;
  }

  return (
    <AppShell>
      <OfflineSyncBanner />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/menus" element={<MenuListPage />} />
        <Route path="/menus/new" element={<MenuEditorPage />} />
        <Route path="/menus/:menuId" element={<MenuDetailPrintPage />} />
        <Route path="/menus/:menuId/revise" element={<MenuEditorPage />} />
        <Route path="/logs" element={<PracticeLogListPage />} />
        <Route path="/logs/new" element={<PracticeLogEditorPage />} />
        <Route path="/logs/day/:dayId" element={<PracticeLogDetailPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
};

export const App: React.FC = () => {
  return (
    <HashRouter>
      <AuthProvider>
        <SwimDataProvider>
          <AuthenticatedApp />
        </SwimDataProvider>
      </AuthProvider>
    </HashRouter>
  );
};

export default App;
