import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  MOCK_ATHLETE_EMAIL,
  MOCK_COACH_EMAIL,
  MOCK_PASSWORD,
  MockSupabaseServer,
} from './mockSupabase';

const SCREENSHOT_DIR = '/tmp/swimlog-audit-screenshots';
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface LayoutAuditRecord {
  screen: string;
  viewport: string;
  docOverflow: number;
  smallTapTargets: Array<{ tag: string; text: string; width: number; height: number }>;
  leakedTokens: string[];
}

const layoutRecords: LayoutAuditRecord[] = [];

async function auditScreen(
  page: Page,
  screenName: string,
  screenshotFilename: string,
  options?: { fullPage?: boolean; preserveScroll?: boolean }
): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(200);
  if (!options?.preserveScroll) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
  }

  const metrics = await page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const bodyText = document.body.innerText ?? '';
    const leaked: string[] = [];
    for (const token of ['NaN', '[object Object]', 'undefined']) {
      if (bodyText.includes(token)) {
        leaked.push(token);
      }
    }

    const smallTargets: Array<{ tag: string; text: string; width: number; height: number }> = [];
    const interactive = document.querySelectorAll('button, a, select, input[type="submit"]');
    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (rect.height < 40 || rect.width < 40) {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 32);
        smallTargets.push({
          tag: el.tagName.toLowerCase(),
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    return {
      docOverflow,
      leaked,
      smallTargets,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  });

  layoutRecords.push({
    screen: screenName,
    viewport: metrics.viewport,
    docOverflow: metrics.docOverflow,
    smallTapTargets: metrics.smallTargets,
    leakedTokens: metrics.leaked,
  });

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, screenshotFilename),
    fullPage: options?.fullPage ?? true,
  });

  expect(
    metrics.docOverflow,
    `Horizontal overflow detected on ${screenName} (${metrics.viewport})`
  ).toBeLessThanOrEqual(1);
  expect(
    metrics.leaked,
    `Unexpected raw token leaked in UI on ${screenName}: ${metrics.leaked.join(', ')}`
  ).toEqual([]);
  expect(
    metrics.smallTargets,
    `Small tap targets (<40px) detected on ${screenName}: ${JSON.stringify(metrics.smallTargets)}`
  ).toEqual([]);
}

function attachRuntimeMonitors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('ERR_INTERNET_DISCONNECTED') && !text.includes('Failed to load resource')) {
        consoleErrors.push(text);
      }
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  return { consoleErrors, pageErrors };
}

async function createMobilePage(browser: Browser, mock: MockSupabaseServer) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  await context.addInitScript(() => {
    if (window.sessionStorage.getItem('__E2E_OFFLINE') === '1') {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => false,
      });
    }
  });
  const page = await context.newPage();
  const monitors = attachRuntimeMonitors(page);
  await mock.attach(page);
  return { context, page, ...monitors };
}

async function signInOnLoginScreen(
  page: Page,
  slot: 'coach' | 'athlete',
  email: string,
  password: string
) {
  await page.getByRole('button', { name: slot === 'coach' ? 'コーチ枠' : '選手枠' }).click();
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
}

function assertCleanRuntime(
  consoleErrors: string[],
  pageErrors: string[],
  context: BrowserContext
) {
  expect(consoleErrors, `Console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  return context.close();
}

test.describe('SwimLog Duo 総合品質・デザイン監査 E2E', () => {
  test.afterAll(() => {
    console.log('=== LAYOUT_AUDIT_SUMMARY_JSON ===');
    console.log(JSON.stringify(layoutRecords, null, 2));
  });

  test('1. ログイン・初回表示名登録ゲート・バリデーション・2アカウント分離切替', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: null,
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'swimlog-duo' })).toBeVisible();
    await expect(page.getByText('β ベータ版')).toBeVisible();
    await auditScreen(page, '01_LoginScreen_Mobile', '01-login-mobile.png');

    // Password visibility toggle
    const pwInput = page.locator('#login-password');
    await expect(pwInput).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'パスワードを表示' }).click();
    await expect(pwInput).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'パスワードを隠す' }).click();

    // Role mismatch rejection
    await signInOnLoginScreen(page, 'athlete', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('正しい枠からログインしてください')).toBeVisible();

    // Athlete first login -> DisplayNameSetupScreen gate
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByRole('heading', { name: '表示名の登録' })).toBeVisible();
    await expect(page.getByRole('button', { name: '表示名を登録して始める' })).toBeEnabled();
    await auditScreen(page, '02_DisplayNameSetup_Mobile', '02-display-name-setup-mobile.png');

    // Protected route bypass check
    await page.goto('/#/menus');
    await expect(page.getByRole('heading', { name: '表示名の登録' })).toBeVisible();
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: '表示名の登録' })).toBeVisible();

    // Full-width space-only input must be rejected
    await page.locator('#onboarding-display-name').fill('　 　');
    await page.getByRole('button', { name: '表示名を登録して始める' }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    // Register valid display name with surrounding full-width spaces
    await page.locator('#onboarding-display-name').fill('　田中 太郎　');
    await page.getByRole('button', { name: '表示名を登録して始める' }).click();

    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('ホーム').click();
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();
    await page.reload();
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();
    await auditScreen(page, '03_AthleteHome_Mobile', '03-athlete-home-mobile.png');

    // Switch to Coach slot -> sign in -> switch back to Athlete without losing Athlete session
    await page.locator('header button').filter({ hasText: '田中 太郎' }).click();
    await expect(page.getByText('コーチアカウントでログイン')).toBeVisible();
    await signInOnLoginScreen(page, 'coach', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('コーチダッシュボード · 佐藤 コーチ')).toBeVisible();

    await page.locator('header button').filter({ hasText: '佐藤 コーチ' }).click();
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('2. コーチ：メニュー作成・詳細/印刷・改訂(v2)・共有切替・テンプレート・検索', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await signInOnLoginScreen(page, 'coach', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('コーチダッシュボード · 佐藤 コーチ')).toBeVisible();
    await auditScreen(page, '04_CoachHome_Mobile', '04-coach-home-mobile.png');

    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('メニュー').click();
    await expect(page.getByRole('heading', { name: '練習メニュー一覧' })).toBeVisible();
    await page.getByRole('button', { name: 'テンプレート登録' }).first().click();
    await auditScreen(page, '05_CoachMenus_Mobile', '05-coach-menus-mobile.png');

    // Create new menu
    await page.getByRole('link', { name: '新規作成' }).click();
    await expect(page.getByRole('heading', { name: '新しい練習メニューを作成' })).toBeVisible();
    await page.locator('#menu-title').fill('2026-11-25 スプリント強化メニュー');
    await page.getByRole('button', { name: 'メニュー行を追加' }).click();
    await auditScreen(page, '06_CoachMenuEditor_Mobile', '06-coach-menu-new-mobile.png');

    await page.getByRole('button', { name: 'メニューを保存' }).click();
    await expect(page.getByRole('heading', { name: '2026-11-25 スプリント強化メニュー' })).toBeVisible();
    await auditScreen(page, '07_CoachMenuDetail_Mobile', '07-coach-menu-detail-mobile.png');

    // Revise menu -> v2
    await page.getByRole('link', { name: '改訂（新版作成）' }).click();
    await expect(page.getByRole('heading', { name: 'メニュー改訂（新バージョン作成）' })).toBeVisible();
    await page.locator('#menu-title').fill('2026-11-25 スプリント強化メニュー v2');
    await page.getByRole('button', { name: '新バージョンを保存' }).click();
    await expect(page.getByText('第2版')).toBeVisible();

    // Toggle share -> unshare -> share
    await page.getByRole('button', { name: '非共有にする' }).click();
    await expect(page.getByRole('button', { name: '共有中にする' })).toBeVisible();
    await page.getByRole('button', { name: '共有中にする' }).click();
    await expect(page.getByRole('button', { name: '非共有にする' })).toBeVisible();

    // Search filter
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('メニュー').click();
    await page.getByPlaceholder('メニュー名・種目・強度・指示で検索').fill('スプリント強化');
    await expect(page.getByText('2026-11-25 スプリント強化メニュー v2')).toBeVisible();

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('3. 選手＆コーチ連携：練習記録入力・バリデーション・保存・日次メモ編集・変更履歴・コーチコメント', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('メニュー').click();
    await expect(page.getByText('2026-11-24 基本有酸素トレーニング')).toBeVisible();
    await auditScreen(page, '08_AthleteMenus_Mobile', '08-athlete-menus-mobile.png');

    await page.getByRole('link', { name: 'このメニューで記録' }).first().click();
    await expect(page.getByRole('heading', { name: '練習日の登録' })).toBeVisible();

    // Invalid time format check
    const firstSetTimeInput = page.locator('input[placeholder="31.45"]').first();
    await firstSetTimeInput.fill('invalid-time');
    await page.getByRole('button', { name: '練習記録を保存する' }).click();
    await expect(page.getByText('代表タイム形式が正しくありません')).toBeVisible();

    // Valid input & submit
    await firstSetTimeInput.fill('31.45');
    await page.locator('input[placeholder="31.2, 31.5, 31.8"]').first().fill('31.2, 31.5');
    await page.locator('input[placeholder="45:00"]').fill('42:00');
    await page.locator('textarea').first().fill('キックのテンポを意識できた');
    await auditScreen(page, '09_AthleteLogNew_Mobile', '09-athlete-log-new-mobile.png');

    await page.getByRole('button', { name: '練習記録を保存する' }).click();
    await expect(page).toHaveURL(/#\/logs\/day\//);
    await expect(page.getByText('42:00.00')).toBeVisible();
    await expect(page.getByText('キックのテンポを意識できた')).toBeVisible();
    await auditScreen(page, '10_AthleteLogDetail_Mobile', '10-athlete-log-detail-mobile.png');

    // Edit day note & check human-readable change history
    await page.getByRole('button', { name: '日次メモ編集' }).click();
    await page.locator('textarea').first().fill('朝練 25m 体調良好');
    await page.getByRole('button', { name: 'メモを保存' }).click();
    await expect(page.getByText('朝練 25m 体調良好')).toBeVisible();
    await expect(page.getByText(/変更前:/)).toBeVisible();

    // Practice Log List
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('練習記録').click();
    await expect(page.getByRole('heading', { name: '練習記録一覧' })).toBeVisible();
    await auditScreen(page, '11_AthleteLogList_Mobile', '11-athlete-log-list-mobile.png');

    // Coach signs in and adds comment
    await page.locator('header button').filter({ hasText: '田中 太郎' }).click();
    await signInOnLoginScreen(page, 'coach', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.locator('header button').filter({ hasText: '佐藤 コーチ' })).toBeVisible();
    await page.getByRole('button', { name: '同期を実行' }).click();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('練習記録').click();
    await page.locator('main a[href^="#/logs/day/"]').first().click();

    await page.getByRole('button', { name: 'コメントを書く' }).click();
    await page.locator('textarea[placeholder*="フィードバックコメント"]').fill('後半のキャッチが安定しています！');
    await page.getByRole('button', { name: 'コメントを投稿' }).click();
    await expect(page.getByText('後半のキャッチが安定しています！')).toBeVisible();
    await auditScreen(page, '12_CoachLogDetail_Mobile', '12-coach-log-detail-mobile.png');

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('4. [P0検証] 練習記録入力：下書きの自動保存・リロード復元・アカウント切替後の保持', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    await page.getByRole('link', { name: '練習を記録する' }).click();
    await expect(page.getByRole('heading', { name: '練習日の登録' })).toBeVisible();

    await page.locator('input[placeholder="31.45"]').first().fill('31.45');
    await page.locator('input[placeholder="45:00"]').fill('42:00');
    await page.locator('textarea').first().fill('下書き復元テストメモ');
    await page.waitForTimeout(500);

    // Reload in StrictMode and confirm draft is restored
    await page.reload();
    await expect(page.locator('input[placeholder="31.45"]').first()).toHaveValue('31.45', {
      timeout: 5000,
    });
    await expect(page.locator('input[placeholder="45:00"]')).toHaveValue('42:00', {
      timeout: 5000,
    });
    await expect(page.locator('textarea').first()).toHaveValue('下書き復元テストメモ', {
      timeout: 5000,
    });

    // Switch to Coach account while on /logs/new -> Coach must not see Athlete draft, then visit Coach Home
    await page.locator('header button').filter({ hasText: '田中 太郎' }).click();
    await signInOnLoginScreen(page, 'coach', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.locator('header button').filter({ hasText: '佐藤 コーチ' })).toBeVisible();
    await expect(page.getByText('練習記録の入力は選手アカウントのみ操作できます。')).toBeVisible();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('ホーム').click();
    await expect(page.getByText('コーチダッシュボード · 佐藤 コーチ')).toBeVisible();

    // Return to Athlete -> navigate to /logs/new -> draft must still be preserved
    await page.locator('header button').filter({ hasText: '佐藤 コーチ' }).click();
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();
    await page.getByRole('link', { name: '練習を記録する' }).click();
    await expect(page.locator('input[placeholder="31.45"]').first()).toHaveValue('31.45', {
      timeout: 5000,
    });
    await expect(page.locator('input[placeholder="45:00"]')).toHaveValue('42:00', {
      timeout: 5000,
    });
    await expect(page.locator('textarea').first()).toHaveValue('下書き復元テストメモ', {
      timeout: 5000,
    });

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('5. オフライン編集・リロード保持・再接続時の競合解決', async ({ browser }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const dayId = '77777777-7777-4777-8777-777777777771';
    const entryId = '88888888-8888-4888-8888-888888888881';
    mock.state.practice_days.push({
      id: dayId,
      athlete_id: '22222222-2222-4222-8222-222222222222',
      practice_date: '2026-11-24',
      note: '初期メモ',
      is_deleted: false,
      revision: 1,
      expected_revision: null,
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-11-24T07:00:00.000Z',
      updated_by: null,
      updated_at: '2026-11-24T07:00:00.000Z',
    });
    mock.state.practice_entries.push({
      id: entryId,
      day_id: dayId,
      menu_version_id: '44444444-4444-4444-8444-444444444441',
      sort_order: 1,
      total_time_ms: 2520000,
      rating: 4,
      impression: '順調',
      is_deleted: false,
      revision: 1,
      expected_revision: null,
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-11-24T07:00:00.000Z',
      updated_by: null,
      updated_at: '2026-11-24T07:00:00.000Z',
    });

    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    await page.goto(`/#/logs/day/${dayId}`);
    await expect(page.getByText('初期メモ')).toBeVisible();

    // Go offline
    mock.offlineBlocked = true;
    await page.evaluate(() => {
      window.sessionStorage.setItem('__E2E_OFFLINE', '1');
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event('offline'));
    });
    await expect(page.getByText(/オフラインモード/)).toBeVisible();

    // Edit day note offline
    await page.getByRole('button', { name: '日次メモ編集' }).click();
    await page.locator('textarea').first().fill('オフライン端末メモ');
    await page.getByRole('button', { name: 'メモを保存' }).click();
    await expect(page.getByText('未送信 1件')).toBeVisible();

    // Reload while offline -> offline fallback session & outbox survive
    await page.reload();
    await expect(page.getByText(/オフラインモード/)).toBeVisible();
    await expect(page.getByText('未送信 1件')).toBeVisible();

    // Simulate concurrent server edit -> reconnect -> conflict modal
    mock.bumpServerDayRevision(dayId, 'コーチ側の先着更新メモ');
    mock.offlineBlocked = false;
    await page.evaluate(() => {
      window.sessionStorage.removeItem('__E2E_OFFLINE');
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event('online'));
    });

    await expect(page.getByText(/同じ記録への変更が重なりました/)).toBeVisible();
    await page.getByRole('button', { name: '競合を確認・解決' }).click();
    await expect(page.getByRole('heading', { name: '変更の競合を解決' })).toBeVisible();
    await auditScreen(page, '13_ConflictResolverModal_Mobile', '13-conflict-modal-mobile.png', {
      fullPage: false,
      preserveScroll: true,
    });

    await page.locator('div[role="dialog"] textarea').fill('コーチ・選手統合メモ');
    await page.getByRole('button', { name: '入力内容で統合して保存' }).click();
    await expect(page.getByText(/同じ記録への変更が重なりました/)).toHaveCount(0);
    await expect(page.getByText('コーチ・選手統合メモ')).toBeVisible({ timeout: 10_000 });

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('6. 設定（表示名変更・大会登録・バックアップ保存復元・OSテーマ追従）・分析画面・デスクトップ確認', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const dayId = '77777777-7777-4777-8777-777777777771';
    const entryId = '88888888-8888-4888-8888-888888888881';
    mock.state.practice_days.push({
      id: dayId,
      athlete_id: '22222222-2222-4222-8222-222222222222',
      practice_date: '2026-11-24',
      note: '朝練',
      is_deleted: false,
      revision: 1,
      expected_revision: null,
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-11-24T07:00:00.000Z',
      updated_by: null,
      updated_at: '2026-11-24T07:00:00.000Z',
    });
    mock.state.practice_entries.push({
      id: entryId,
      day_id: dayId,
      menu_version_id: '44444444-4444-4444-8444-444444444441',
      sort_order: 1,
      total_time_ms: 2520000,
      rating: 4,
      impression: '良好',
      is_deleted: false,
      revision: 1,
      expected_revision: null,
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-11-24T07:00:00.000Z',
      updated_by: null,
      updated_at: '2026-11-24T07:00:00.000Z',
    });
    mock.state.set_results.push({
      id: '99999999-9999-4999-8999-999999999991',
      entry_id: entryId,
      row_id: '55555555-5555-4555-8555-555555555551',
      time_ms: 61450,
      splits: [{ rep: 1, time_ms: 61450 }],
      rating: 4,
      impression: 'いいペース',
      is_deleted: false,
      revision: 1,
      expected_revision: null,
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-11-24T07:00:00.000Z',
      updated_by: null,
      updated_at: '2026-11-24T07:00:00.000Z',
    });

    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('設定').click();
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();

    // Register local competition via explicit labels
    await page.getByLabel('大会名（必須）').fill('冬季チャンピオンシップ');
    await page.getByLabel('大会開催日（必須）').fill('2026-12-20');
    await page.getByLabel('目標メモ（任意）').fill('100m Fr ベスト更新');
    await page.getByRole('button', { name: '追加' }).click();
    await expect(page.getByText('冬季チャンピオンシップ')).toBeVisible();

    // Update display name in Settings
    const settingsNameInput = page.locator('#settings-display-name');
    await settingsNameInput.fill('田中 太郎 (選手)');
    await page.getByRole('button', { name: '表示名を保存' }).click();
    await expect(page.getByText('表示名を「田中 太郎 (選手)」に更新しました。')).toBeVisible();

    // Export backup & re-import it
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'バックアップを保存' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('swimlog-duo-backup-athlete');
    const savedBackupPath = path.join('/tmp/swimlog-pw-results', download.suggestedFilename());
    await download.saveAs(savedBackupPath);
    await page.locator('input[type="file"][accept="application/json"]').setInputFiles(savedBackupPath);
    await expect(page.getByText(/バックアップを復元しました/)).toBeVisible();

    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await auditScreen(page, '14_Settings_Light_Mobile', '14-settings-light-mobile.png');

    // Emulate OS Dark Mode -> verify automatic switch without reload
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await auditScreen(page, '15_Settings_Dark_Mobile', '15-settings-dark-mobile.png');

    // Analytics (Dark Mobile)
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('分析').click();
    await expect(page.getByRole('heading', { name: '練習データの分析' })).toBeVisible();
    await expect(page.getByText('冬季チャンピオンシップ')).toBeVisible();
    await auditScreen(page, '16_Analytics_Dark_Mobile', '16-analytics-dark-mobile.png');

    // Switch back to OS Light Mode
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Desktop viewport audit
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/');
    await expect(page.getByText('選手ダッシュボード · 田中 太郎 (選手)')).toBeVisible();
    await auditScreen(page, '17_AthleteHome_Desktop', '17-athlete-home-desktop.png');

    await page.goto('/#/analytics');
    await expect(page.getByRole('heading', { name: '練習データの分析' })).toBeVisible();
    await auditScreen(page, '18_Analytics_Desktop', '18-analytics-desktop.png');

    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
    await auditScreen(page, '19_Settings_Desktop', '19-settings-desktop.png');

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('7. OSテーマ自動追従（ライト／ダーク）と手動テーマ設定UIの廃止確認', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    await page.goto('/');
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Login screen follows OS dark/light automatically
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('選手ダッシュボード · 田中 太郎')).toBeVisible();

    // No manual theme toggle controls exist in header or settings
    await expect(page.getByRole('button', { name: /ライトモード|ダークモード/ })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('設定').click();
    await expect(page.getByText('画面テーマ')).toHaveCount(0);

    // Switching OS color scheme updates authenticated UI immediately
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });

  test('8. コーチ・選手間主要連携フロー：メニュー作成・保存編集・共有・選手確認・記録作成・コーチ確認・コメント・選手確認', async ({
    browser,
  }) => {
    const mock = new MockSupabaseServer({
      athleteDisplayName: '田中 太郎',
      coachDisplayName: '佐藤 コーチ',
    });
    const { context, page, consoleErrors, pageErrors } = await createMobilePage(browser, mock);

    // 1. コーチによる練習メニュー作成
    await page.goto('/');
    await signInOnLoginScreen(page, 'coach', MOCK_COACH_EMAIL, MOCK_PASSWORD);
    await expect(page.getByText('コーチダッシュボード · 佐藤 コーチ')).toBeVisible();

    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('メニュー').click();
    await page.getByRole('link', { name: '新規作成' }).click();
    await expect(page.getByRole('heading', { name: '新しい練習メニューを作成' })).toBeVisible();
    await page.locator('#menu-title').fill('連携テスト用 スプリント強化');
    await page.getByRole('button', { name: 'メニュー行を追加' }).click();

    // 2. メニューの保存・編集
    await page.getByRole('button', { name: 'メニューを保存' }).click();
    await expect(page.getByRole('heading', { name: '連携テスト用 スプリント強化' })).toBeVisible();

    // 改訂・編集（v2作成）
    await page.getByRole('link', { name: '改訂（新版作成）' }).click();
    await expect(page.getByRole('heading', { name: 'メニュー改訂（新バージョン作成）' })).toBeVisible();
    await page.locator('#menu-title').fill('連携テスト用 スプリント強化 v2');
    await page.getByRole('button', { name: '新バージョンを保存' }).click();
    await expect(page.getByText('第2版')).toBeVisible();

    // 3. メニューの共有
    const shareButton = page.getByRole('button', { name: '共有中にする' });
    if (await shareButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await shareButton.click();
    }
    await expect(page.getByRole('button', { name: '非共有にする' })).toBeVisible();

    // 4. 選手側での共有メニュー確認
    await page.locator('header button').filter({ hasText: '佐藤 コーチ' }).click();
    await signInOnLoginScreen(page, 'athlete', MOCK_ATHLETE_EMAIL, MOCK_PASSWORD);
    await expect(page.locator('header button').filter({ hasText: '田中 太郎' })).toBeVisible();
    await page.getByRole('button', { name: '同期を実行' }).click();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('メニュー').click();
    await expect(page.getByText('連携テスト用 スプリント強化 v2')).toBeVisible();

    // 5. 選手による練習記録の作成
    await page
      .locator('div')
      .filter({ hasText: '連携テスト用 スプリント強化 v2' })
      .getByRole('link', { name: 'このメニューで記録' })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '練習日の登録' })).toBeVisible();

    const firstSetInput = page.locator('input[placeholder="31.45"]').first();
    if (await firstSetInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstSetInput.fill('30.20');
    }
    await page.locator('input[placeholder="45:00"]').fill('38:30');
    await page.locator('textarea').first().fill('テンポよく泳ぎ切ることができた');
    await page.getByRole('button', { name: '練習記録を保存する' }).click();
    await expect(page).toHaveURL(/#\/logs\/day\//);
    await expect(page.getByText('38:30.00')).toBeVisible();
    await expect(page.getByText('テンポよく泳ぎ切ることができた')).toBeVisible();

    // 6. コーチ側での練習記録確認（ヘッダータップで即座にコーチ枠へ切替）
    await page.locator('header button').filter({ hasText: '田中 太郎' }).click();
    await expect(page.locator('header button').filter({ hasText: '佐藤 コーチ' })).toBeVisible();
    await page.getByRole('button', { name: '同期を実行' }).click();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('練習記録').click();
    await page.locator('main a[href^="#/logs/day/"]').first().click();
    await expect(page.getByText('38:30.00')).toBeVisible();
    await expect(page.getByText('テンポよく泳ぎ切ることができた')).toBeVisible();

    // 7. コーチによるコメント投稿
    await page.getByRole('button', { name: 'コメントを書く' }).click();
    await page.locator('textarea[placeholder*="フィードバックコメント"]').fill('素晴らしいペース配分です！');
    await page.getByRole('button', { name: 'コメントを投稿' }).click();
    await expect(page.getByText('素晴らしいペース配分です！')).toBeVisible();

    // 8. 選手側でのコメント確認（ヘッダータップで選手枠へ戻る）
    await page.locator('header button').filter({ hasText: '佐藤 コーチ' }).click();
    await expect(page.locator('header button').filter({ hasText: '田中 太郎' })).toBeVisible();
    await page.getByRole('button', { name: '同期を実行' }).click();
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('練習記録').click();
    await page.locator('main a[href^="#/logs/day/"]').first().click();
    await expect(page.getByText('素晴らしいペース配分です！')).toBeVisible();

    // 選手ホーム画面の「最新のコーチコメント」欄でも確認
    await page.getByRole('navigation', { name: 'モバイルナビゲーション' }).getByText('ホーム').click();
    await expect(page.getByText('素晴らしいペース配分です！')).toBeVisible();

    await assertCleanRuntime(consoleErrors, pageErrors, context);
  });
});
