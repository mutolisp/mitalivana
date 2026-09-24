/**
 * Sign in with ORCID inside an in-app WebView (see src/lib/orcidAuth.ts for
 * the flow and why each check exists).
 *
 * The WebView is allowed to go anywhere — ORCID's sign-in can hand over to an
 * institution's SSO — except the registered redirect URI: that navigation is
 * stopped and its URL read instead. `incognito` so no ORCID session lingers in
 * the app: every sign-in is a fresh one, and switching account just works.
 *
 * Rendered from a Stack screen (provenance settings), not from inside another
 * Modal, so presenting this Modal is safe.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { generateUuid } from '~/db';
import {
  buildAuthorizeUrl,
  confirmWithOrcid,
  isRedirect,
  parseRedirect,
  type OrcidAuthRequest,
  type OrcidIdentity,
} from '~/lib/orcidAuth';

export type OrcidSignInResult =
  | { kind: 'ok'; identity: OrcidIdentity }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'failed' };

type Props = {
  config: { base: string; clientId: string; redirectUri: string };
  onDone: (result: OrcidSignInResult) => void;
};

export function OrcidSignInModal({ config, onDone }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // One request per mount: fresh single-use nonce and state.
  const req = useMemo<OrcidAuthRequest>(
    () => ({ ...config, nonce: generateUuid(), state: generateUuid() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handled = useRef(false);
  const [checking, setChecking] = useState(false);

  /** Both hooks below can see the redirect (Android does not always report a
   *  server redirect to onShouldStartLoadWithRequest); only the first counts. */
  const handleRedirect = (url: string) => {
    if (handled.current) return;
    handled.current = true;
    const parsed = parseRedirect(url, req, Date.now());
    if (!parsed.ok) {
      onDone({ kind: parsed.reason === 'denied' ? 'denied' : 'failed' });
      return;
    }
    setChecking(true);
    confirmWithOrcid(req.base, parsed.identity)
      .then((confirmed) =>
        onDone(confirmed ? { kind: 'ok', identity: parsed.identity } : { kind: 'failed' }),
      )
      .catch(() => onDone({ kind: 'failed' }));
  };

  return (
    <Modal visible animationType="slide" onRequestClose={() => onDone({ kind: 'cancelled' })}>
      <View className="flex-1 bg-white dark:bg-gray-900" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Pressable onPress={() => onDone({ kind: 'cancelled' })} hitSlop={8}>
            <Text className="text-base text-gray-700 dark:text-gray-300">{t('common.cancel')}</Text>
          </Pressable>
          <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('provenance.orcidSignInTitle')}
          </Text>
          <View style={{ width: 44 }} />
        </View>
        {checking ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
            <Text className="mt-3 text-sm text-gray-600 dark:text-gray-400">
              {t('provenance.orcidChecking')}
            </Text>
          </View>
        ) : (
          <WebView
            source={{ uri: buildAuthorizeUrl(req) }}
            incognito
            onShouldStartLoadWithRequest={(r) => {
              if (isRedirect(r.url, req.redirectUri)) {
                handleRedirect(r.url);
                return false;
              }
              return true;
            }}
            onNavigationStateChange={(nav: WebViewNavigation) => {
              if (isRedirect(nav.url, req.redirectUri)) handleRedirect(nav.url);
            }}
            startInLoadingState
            style={{ flex: 1, paddingBottom: insets.bottom }}
          />
        )}
      </View>
    </Modal>
  );
}
