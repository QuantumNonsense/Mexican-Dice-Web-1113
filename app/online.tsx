import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import FeltBackground from '../src/components/FeltBackground';
import { ScoreDie } from '../src/components/ScoreDie';
import StyledButton from '../src/components/StyledButton';
import { splitClaim } from '../src/engine/mexican';
import { ensureUserProfile } from '../src/lib/auth';
import { normalizeColorAnimalName } from '../src/lib/colorAnimalName';
import { supabase } from '../src/lib/supabase';

const STARTING_SCORE = 5;
const MAX_ACTIVE_GAMES = 5;
const INITIAL_ROUND_STATE = {
  baselineClaim: null,
  lastAction: 'normal',
  lastClaimer: null,
  history: [],
  hostRoll: null,
  guestRoll: null,
  hostMustBluff: false,
  guestMustBluff: false,
  lastClaimRoll: null,
  socialRevealDice: null,
  socialRevealNonce: 0,
  hostSelfiesUsed: 0,
  guestSelfiesUsed: 0,
  activeClaimSelfie: null,
  selfieArchive: [],
  lastSelfieBy: null,
  lastSelfieNonce: 0,
  lastBluffCaller: null,
  lastBluffDefenderTruth: null,
  bluffResultNonce: 0,
};

type LobbyGame = {
  id: string;
  status: 'waiting' | 'in_progress' | 'finished' | 'cancelled';
  host_id: string;
  guest_id: string | null;
  host_score: number | null;
  guest_score: number | null;
  current_player_id: string | null;
  last_claim: number | string | null;
  updated_at: string;
  host?: { username: string | null };
  guest?: { username: string | null };
  round_state?: any;
  matchmaking_type?: 'friend' | 'random' | null;
};

const MAX_USERNAME_LENGTH = 40;

// Allow only letters, spaces, and hyphens for friend usernames
const isValidFriendUsername = (raw: string) => {
  const value = raw.trim();
  if (!value) return false;
  if (value.length > MAX_USERNAME_LENGTH) return false;

  // Updated to allow digits in ColorAnimalNN usernames (letters, numbers, spaces, hyphens).
  const safePattern = /^[A-Za-z0-9\s-]+$/;
  return safePattern.test(value);
};

const SCORE_DIE_BASE_SIZE = 38;
const CURRENT_CLAIM_DIE_SCALE = 0.8;

export default function OnlineLobbyScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [friendCode, setFriendCode] = useState('');
  const [myUsername, setMyUsername] = useState<string | null>(null);
  const [creatingMatch, setCreatingMatch] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [games, setGames] = useState<LobbyGame[]>([]);
  const [usernamesById, setUsernamesById] = useState<Record<string, string>>({});
  const [loadingGames, setLoadingGames] = useState(false);

  const handleClearAndroidBadges = useCallback(async () => {
    try {
      await Notifications.dismissAllNotificationsAsync();
      try {
        await Notifications.setBadgeCountAsync(0);
      } catch {}
      Alert.alert('Badge notifications have been cleared');
    } catch (err) {
      if (__DEV__) console.warn('[online] failed to clear android notifications', err);
      Alert.alert('Could not clear notifications');
    }
  }, []);

  const onClearBadge = useCallback(async () => {
    if (Platform.OS !== 'ios') return;
    try {
      await Notifications.setBadgeCountAsync(0);
      Alert.alert('Badge cleared');
    } catch (e) {
      if (__DEV__) console.warn('[online] failed to clear badge', e);
      Alert.alert('Could not clear badge');
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    (async () => {
    try {
      const profile = await ensureUserProfile();
      if (isMounted) {
        setUserId(profile.id);
        setMyUsername(profile.username ?? null);
      }
    } catch (err) {
      console.error('[OnlineLobby] Failed to load user', err);
      const detail = err instanceof Error && err.message ? err.message : 'Please try again.';
      Alert.alert('Unable to load account', detail);
    } finally {
      if (isMounted) {
        setLoadingUser(false);
        }
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const getActiveGameCount = useCallback(
    async (id: string) => {
      const { count, error } = await supabase
        .from('games_v2')
        .select('id', { count: 'exact', head: true })
        .in('status', ['waiting', 'in_progress'])
        .or(`host_id.eq.${id},guest_id.eq.${id}`);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    []
  );

  const loadGames = useCallback(async () => {
    if (!userId) return;
    setLoadingGames(true);
    const { data, error } = await supabase
      .from('games_v2')
      .select('*')
      .or(`host_id.eq.${userId},guest_id.eq.${userId}`)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[OnlineLobby] Failed to load matches', error);
      Alert.alert('Unable to load matches', error.message);
      setGames([]);
    } else {
      const rows = (data ?? []) as LobbyGame[];

      // Filter out cancelled games immediately so the UI never shows them
      const visibleRows = rows.filter((g) => g.status !== 'cancelled');
      setGames(visibleRows);

      console.log(
        '[OnlineLobby] Loaded games for',
        userId,
        rows.map((g: any) => ({
          id: g.id,
          status: g.status,
          host_id: g.host_id,
          guest_id: g.guest_id,
          current_player_id: g.current_player_id,
          host_score: g.host_score,
          guest_score: g.guest_score,
        }))
      );

      // Build a unique list of player IDs for these games
      const ids = Array.from(
        new Set(
          rows
            .flatMap((g) => [g.host_id, g.guest_id])
            .filter((id): id is string => !!id)
        )
      );

      if (ids.length > 0) {
        const { data: usersData, error: usersError } = await supabase
          .from('users')
          .select('id, username')
          .in('id', ids);

        if (!usersError && usersData) {
          const map: Record<string, string> = {};
          for (const u of usersData) {
            if (u.id && u.username) {
              map[u.id] = u.username;
            }
          }
          setUsernamesById(map);
        } else if (usersError) {
          console.warn('[OnlineLobby] Failed to load usernames', usersError);
        }
      }
    }
    setLoadingGames(false);
  }, [userId]);

  useEffect(() => {
    if (userId) loadGames();
  }, [userId, loadGames]);

  useFocusEffect(
    useCallback(() => {
      loadGames();
    }, [loadGames])
  );

  useEffect(() => {
    if (!userId) return;

    console.log('[ONLINE LOBBY] setting up realtime subscription', { userId });

    let isMounted = true;
    let hasSubscribedOnce = false;

    const handleChange = (payload: { eventType: string; new: unknown; old: unknown }) => {
      if (!isMounted) return;
      console.log('[ONLINE LOBBY] realtime update', {
        type: payload.eventType,
        gameId: (payload.new as any)?.id ?? (payload.old as any)?.id ?? null,
      });
      void loadGames();
    };

    // postgres_changes filters only support a single column; subscribe once per role.
    const channel = supabase
      .channel(`lobby-games-v2-${userId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'games_v2', filter: `host_id=eq.${userId}` },
        handleChange
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'games_v2', filter: `guest_id=eq.${userId}` },
        handleChange
      )
      .subscribe((status) => {
        if (!isMounted) return;
        if (status === 'SUBSCRIBED') {
          if (hasSubscribedOnce) {
            console.log('[ONLINE LOBBY] realtime resubscribed, refetching', { userId });
            void loadGames();
          }
          hasSubscribedOnce = true;
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[ONLINE LOBBY] realtime channel issue, refetching', { userId, status });
          void loadGames();
        }
      });

    return () => {
      isMounted = false;
      console.log('[ONLINE LOBBY] tearing down realtime subscription', { userId });
      void supabase.removeChannel(channel);
    };
  }, [userId, loadGames]);

  const handleCreateMatch = useCallback(async () => {
    if (!userId) {
      Alert.alert('Account missing', 'Please wait for your account to load.');
      return;
    }
    setCreateMessage(null);
    setCreatingMatch(true);
    try {
      const activeCount = await getActiveGameCount(userId);
      if (activeCount >= MAX_ACTIVE_GAMES) {
        Alert.alert(
          'Too many matches',
          'You already have 5 active matches. Finish or delete one before starting a new one.'
        );
        return;
      }

      const trimmed = friendCode.trim();
      if (!trimmed) {
        Alert.alert('Friend required', 'Enter your friend’s username before starting a match.');
        return;
      }

      if (!isValidFriendUsername(trimmed)) {
        Alert.alert(
          'Invalid username',
          'Usernames can contain letters, numbers, spaces, and hyphens, up to 40 characters.'
        );
        return;
      }

      const normalized = normalizeColorAnimalName(trimmed);
      if (!normalized) {
        Alert.alert(
          'Invalid username',
          'Could not parse that username. Double-check the spelling and try again.'
        );
        return;
      }
      const { data: friend, error: friendError } = await supabase
        .from('users')
        .select('id, username')
        .ilike('username', normalized)
        .single();
      if (friendError || !friend) {
        Alert.alert(
          'User not found',
          'Could not find a player with that color-animal code. Double-check the spelling and try again.'
        );
        return;
      }
      if (friend.id === userId) {
        Alert.alert('Invalid opponent', 'You cannot start a match against yourself.');
        return;
      }
      const guestId = friend.id;
      const friendlyName = friend.username ?? normalized;

      const payload: Record<string, any> = {
        host_id: userId,
        guest_id: guestId,
        status: 'in_progress',
        current_player_id: userId,
        host_score: STARTING_SCORE,
        guest_score: STARTING_SCORE,
        last_roll_1: null,
        last_roll_2: null,
        last_claim: null,
        round_state: INITIAL_ROUND_STATE,
        matchmaking_type: 'friend',
      };

      const { data, error } = await supabase.from('games_v2').insert(payload).select('id').single();
      if (error || !data) {
        throw error ?? new Error('Unable to create match');
      }

      try {
        await supabase.functions.invoke('push-game-request-auth', {
          body: { targetUserId: guestId, gameId: data.id },
        });
      } catch (pushError) {
        console.warn('[OnlineLobby] push-game-request-auth failed', pushError);
      }

      setFriendCode('');
      setCreateMessage(`Match started with ${friendlyName ?? 'your friend'}.`);
      await loadGames();
      router.push(`/online/game-v2/${data.id}` as const);
    } catch (err: any) {
      console.error('[OnlineLobby] Create match failed', err);
      Alert.alert('Could not start match', err?.message ?? 'Please try again.');
    } finally {
      setCreatingMatch(false);
    }
  }, [friendCode, getActiveGameCount, loadGames, router, userId]);

  const refreshChallenges = useCallback(() => {
    console.log('[ONLINE] Refreshing challenges…');
    void loadGames();
  }, [loadGames]);

  const handleCopyUsername = useCallback(async () => {
    if (!myUsername) return;
    await Clipboard.setStringAsync(myUsername);
    Alert.alert('Copied', 'Your username has been copied to the clipboard.');
  }, [myUsername]);

  const handleDeleteWaiting = useCallback(
    (game: LobbyGame) => {
      if (!userId) {
        console.warn('[OnlineLobby] Delete requested without userId, ignoring.', {
          gameId: game.id,
          host_id: game.host_id,
          guest_id: game.guest_id,
          status: game.status,
        });
        return;
      }

      const isHost = game.host_id === userId;
      const isGuest = game.guest_id === userId;
      if (!isHost && !isGuest) {
        console.warn('[OnlineLobby] Delete requested without ownership match, aborting.', {
          gameId: game.id,
          userId,
        });
        return;
      }

      console.log('[OnlineLobby] Delete requested', {
        gameId: game.id,
        userId,
        host_id: game.host_id,
        guest_id: game.guest_id,
        status: game.status,
      });

      const roleLabel = isHost ? 'Host' : 'Guest';
      const appendHistoryEvent = (text: string) => {
        const existing = (game.round_state ?? INITIAL_ROUND_STATE) as Record<string, unknown>;
        const history = Array.isArray(existing.history) ? existing.history : [];
        return {
          ...existing,
          history: [
            ...history,
            {
              id: Math.random().toString(36).slice(2, 10),
              type: 'event',
              text,
              timestamp: new Date().toISOString(),
            },
          ],
        };
      };

      const withOwnership = <T extends { eq: (column: string, value: string) => T }>(query: T) =>
        isHost ? query.eq('host_id', userId) : query.eq('guest_id', userId);

      // Games that never started are simply cancelled.
      const runCancel = async () => {
        try {
          console.log('[OnlineLobby] Cancelling unstarted match', { gameId: game.id, userId });

          // Optimistic UI removal so the tile disappears instantly
          setGames((prev) => prev.filter((g) => g.id !== game.id));

          const { error } = await withOwnership(
            supabase
              .from('games_v2')
              .update({
                status: 'cancelled',
                round_state: appendHistoryEvent(`${roleLabel} cancelled the match.`),
              })
              .eq('id', game.id)
              .eq('status', 'waiting')
          );

          if (error) {
            console.error('[OnlineLobby] Cancel Supabase error', error);
            Alert.alert('Unable to delete match', error.message ?? 'Please try again.');
            await loadGames();
            return;
          }

          console.log('[OnlineLobby] Cancel success', { id: game.id });
          await loadGames();
        } catch (err: any) {
          console.error('[OnlineLobby] Cancel match failed', err);
          Alert.alert('Unable to delete match', err?.message ?? 'Please try again.');
          await loadGames();
        }
      };

      // Games already in progress are forfeited: the match is finished with the
      // canceller's score at 0 so the opponent wins and normal finished handling runs.
      const runForfeit = async () => {
        try {
          console.log('[OnlineLobby] Forfeiting match', { gameId: game.id, userId });

          const { error } = await withOwnership(
            supabase
              .from('games_v2')
              .update({
                status: 'finished',
                host_score: isHost ? 0 : game.host_score ?? STARTING_SCORE,
                guest_score: isGuest ? 0 : game.guest_score ?? STARTING_SCORE,
                round_state: appendHistoryEvent(`${roleLabel} resigned the match.`),
              })
              .eq('id', game.id)
              .eq('status', 'in_progress')
          );

          if (error) {
            console.error('[OnlineLobby] Forfeit Supabase error', error);
            Alert.alert('Unable to forfeit match', error.message ?? 'Please try again.');
            return;
          }

          console.log('[OnlineLobby] Forfeit success', { id: game.id });
          await loadGames();
        } catch (err: any) {
          console.error('[OnlineLobby] Forfeit match failed', err);
          Alert.alert('Unable to forfeit match', err?.message ?? 'Please try again.');
        }
      };

      if (game.status === 'in_progress') {
        Alert.alert(
          'Forfeit this match?',
          'This match is already in progress. Leaving it counts as a forfeit: your score will be set to 0 and your opponent will be awarded the win.',
          [
            { text: 'Keep playing', style: 'cancel' },
            { text: 'Forfeit', style: 'destructive', onPress: () => void runForfeit() },
          ]
        );
        return;
      }

      if (game.status === 'waiting') {
        void runCancel();
        return;
      }

      console.warn('[OnlineLobby] Delete requested for a game that cannot be cancelled', {
        gameId: game.id,
        status: game.status,
      });
    },
    [loadGames, userId]
  );

  const sections = useMemo(() => {
    const empty = {
      challenges: [] as LobbyGame[],
      yourTurn: [] as LobbyGame[],
      theirTurn: [] as LobbyGame[],
      completed: [] as LobbyGame[],
    };

    if (!userId) {
      return empty;
    }

    const buckets = { ...empty };

    const activeGames = games.filter((g) => g.status !== 'cancelled');

    activeGames.forEach((game) => {
      if (game.status === 'finished') {
        if (buckets.completed.length < 5) {
          buckets.completed.push(game);
        }
        return;
      }

      const roundStateHistory = Array.isArray((game.round_state as any)?.history)
        ? ((game.round_state as any).history as unknown[])
        : [];
      const hasHistory = roundStateHistory.length > 0;

      const isChallengeForYou =
        game.guest_id === userId &&
        game.status === 'in_progress' &&
        !hasHistory;

      if (isChallengeForYou) {
        buckets.challenges.push(game);
        return;
      }

      if (game.status === 'waiting' && game.host_id === userId && !game.guest_id) {
        buckets.yourTurn.push(game);
        return;
      }

      if (game.status === 'in_progress') {
        if (game.current_player_id === userId) {
          buckets.yourTurn.push(game);
          return;
        }
        if (game.current_player_id && game.current_player_id !== userId) {
          buckets.theirTurn.push(game);
          return;
        }
      }
    });

    return buckets;
  }, [games, userId]);

  const friendYourTurnGames = useMemo(
    () => sections.yourTurn.filter((g) => g.matchmaking_type !== 'random'),
    [sections]
  );
  const randomYourTurnGames = useMemo(
    () => sections.yourTurn.filter((g) => g.matchmaking_type === 'random'),
    [sections]
  );
  const friendTheirTurnGames = useMemo(
    () => sections.theirTurn.filter((g) => g.matchmaking_type !== 'random'),
    [sections]
  );
  const randomTheirTurnGames = useMemo(
    () => sections.theirTurn.filter((g) => g.matchmaking_type === 'random'),
    [sections]
  );
  const friendCompletedGames = useMemo(
    () => sections.completed.filter((g) => g.matchmaking_type !== 'random'),
    [sections]
  );
  const randomCompletedGames = useMemo(
    () => sections.completed.filter((g) => g.matchmaking_type === 'random'),
    [sections]
  );

  const renderGameCard = (game: LobbyGame) => {
    if (!userId) return null;

    const isHost = game.host_id === userId;
    const hostName = usernamesById[game.host_id];
    const guestName = game.guest_id ? usernamesById[game.guest_id] : undefined;

    const opponentName = isHost
      ? game.guest_id
        ? guestName || 'Opponent'
        : 'Waiting for opponent'
      : hostName || 'Opponent';

    const youScore = isHost
      ? game.host_score ?? STARTING_SCORE
      : game.guest_score ?? STARTING_SCORE;
    const themScore = isHost
      ? game.guest_score ?? STARTING_SCORE
      : game.host_score ?? STARTING_SCORE;

    const isCompleted = game.status === 'finished';

    const rawLastClaim = game.last_claim;
    const lastClaimValue: number | null =
      rawLastClaim == null
        ? null
        : typeof rawLastClaim === 'number'
          ? rawLastClaim
          : (() => {
              const parsed = parseInt(rawLastClaim, 10);
              return Number.isNaN(parsed) ? null : parsed;
            })();

    const lastClaimDice = typeof lastClaimValue === 'number' ? splitClaim(lastClaimValue) : null;
    const claimDicePoints = lastClaimDice
      ? lastClaimDice.map((pip) => Math.max(0, Math.min(5, 6 - pip)))
      : null;

    const showCurrentClaim =
      !isCompleted && Array.isArray(claimDicePoints) && claimDicePoints.length === 2;
    const isYourTurnButton =
      (game.status === 'in_progress' && game.current_player_id === userId) ||
      (game.status === 'waiting' && game.host_id === userId && !game.guest_id);

    console.log('[ONLINE LOBBY] match preview', {
      gameId: game.id,
      lobbyClaim: lastClaimValue,
      roundState: game.round_state ?? null,
      last_claim: game.last_claim ?? null,
    });

    // Derive outcome for completed games
    let outcomeLabel: string | null = null;
    if (isCompleted) {
      const history = (game.round_state as any)?.history;
      const lastEvent =
        Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
      const lastText: string | undefined =
        lastEvent && typeof lastEvent.text === 'string' ? lastEvent.text : undefined;

      const hostResigned = !!lastText && lastText.includes('Host resigned the match.');
      const guestResigned = !!lastText && lastText.includes('Guest resigned the match.');

      if (hostResigned || guestResigned) {
        const youAreHost = isHost;
        if (hostResigned) {
          outcomeLabel = youAreHost ? 'You resigned (forfeit)' : 'Opponent resigned (forfeit)';
        } else if (guestResigned) {
          outcomeLabel = youAreHost ? 'Opponent resigned (forfeit)' : 'You resigned (forfeit)';
        }
      } else {
        if (youScore > themScore) {
          outcomeLabel = 'You won';
        } else if (youScore < themScore) {
          outcomeLabel = 'You lost';
        } else {
          outcomeLabel = 'Game over';
        }
      }
    }

    let statusLabel = '';

    const isChallengeForYou =
      game.guest_id === userId &&
      game.status === 'in_progress' &&
      game.current_player_id === game.host_id &&
      (game.host_score ?? STARTING_SCORE) === STARTING_SCORE &&
      (game.guest_score ?? STARTING_SCORE) === STARTING_SCORE;

    if (game.status === 'finished') {
      statusLabel = 'Game over';
    } else if (isChallengeForYou) {
      statusLabel = 'New challenge';
    } else if (game.status === 'waiting' && !game.guest_id) {
      statusLabel = 'Waiting for opponent';
    } else if (game.current_player_id === userId) {
      statusLabel = 'Your turn';
    } else if (game.current_player_id) {
      statusLabel = 'Waiting on friend';
    } else {
      statusLabel = 'Paused';
    }

    const canDelete =
      (game.status === 'waiting' && !game.guest_id && game.host_id === userId) ||
      (game.status === 'in_progress' && (game.host_id === userId || game.guest_id === userId));

    const cardContent = (
          <View style={styles.gameCard}>
        <View style={styles.gameCardHeader}>
          <View style={styles.gameOpponentColumn}>
            <Text style={styles.gameOpponent}>{opponentName}</Text>
            {game.matchmaking_type === 'random' && (
              <Text style={styles.randomBadgeText}>Random match</Text>
            )}
          </View>
          <View style={styles.currentClaimContainer}>
            {showCurrentClaim && claimDicePoints ? (
              <>
                <Text style={styles.currentClaimLabel}>Claim</Text>
                <View style={styles.currentClaimDiceRow}>
                  <ScoreDie
                    points={claimDicePoints[0]}
                    size={SCORE_DIE_BASE_SIZE}
                    style={styles.currentClaimDie}
                  />
                  <View style={{ width: 6 }} />
                  <ScoreDie
                    points={claimDicePoints[1]}
                    size={SCORE_DIE_BASE_SIZE}
                    style={styles.currentClaimDie}
                  />
                </View>
              </>
            ) : (
              <Text style={styles.gameStatus}>{statusLabel}</Text>
            )}
          </View>
        </View>
        <Text style={styles.gameScore}>{`Your Score: ${youScore} • Their Score: ${themScore}`}</Text>
          <View style={styles.cardActions}>
            {isCompleted ? (
              <View style={styles.completedOutcomeContainer}>
                <Text style={styles.completedOutcomeText}>{outcomeLabel ?? 'Game over'}</Text>
              </View>
            ) : (
              <StyledButton
                label="Open Match"
                variant="outline"
                onPress={() => router.push(`/online/game-v2/${game.id}` as const)}
                style={[styles.openMatchButton, isYourTurnButton && styles.openMatchYourTurn]}
                textStyle={isYourTurnButton ? styles.openMatchYourTurnText : undefined}
              />
            )}
          </View>
      </View>
    );

    if (canDelete) {
      return (
        <Swipeable
          key={game.id}
          renderRightActions={() => (
            <View style={styles.swipeDeleteContainer}>
              <TouchableOpacity
                style={styles.swipeDeleteButton}
                onPress={() => handleDeleteWaiting(game)}
              >
                <Text style={styles.swipeDeleteText}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          overshootRight={false}
        >
          {cardContent}
        </Swipeable>
      );
    }

    return <React.Fragment key={game.id}>{cardContent}</React.Fragment>;
  };

  const renderSection = (title: string, data: LobbyGame[], emptyText: string) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {data.length === 0 ? (
        <Text style={styles.emptyTextSmall}>{emptyText}</Text>
      ) : (
        data.map(renderGameCard)
      )}
    </View>
  );

  const renderSplitSection = (
    title: string,
    friendGames: LobbyGame[],
    randomGames: LobbyGame[],
    emptyText: string
  ) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {friendGames.length === 0 && randomGames.length === 0 ? (
        <Text style={styles.emptyTextSmall}>{emptyText}</Text>
      ) : (
        <>
          {friendGames.map(renderGameCard)}
          {randomGames.length > 0 && (
            <>
              {friendGames.length > 0 && (
                <Text style={styles.sectionSubTitle}>Random matches</Text>
              )}
              {randomGames.map(renderGameCard)}
            </>
          )}
        </>
      )}
    </View>
  );

  if (loadingUser) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FE9902" />
        <Text style={styles.loadingText}>Loading online play…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FeltBackground>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.innerContent}>
            <View style={styles.pageContent}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Start a new match</Text>
                <Text style={styles.cardSubtitle}>
                  Invite a friend using their color-animal code, for example BluePanda04.
                </Text>
                {myUsername && (
                  <View style={styles.usernameRow}>
                    <Text style={styles.usernameLabel}>Your Username:</Text>
                    <Pressable onPress={handleCopyUsername} style={styles.usernamePressable}>
                      <Text style={styles.usernameValue}>{myUsername}</Text>
                      <Text style={styles.usernameHint}>(Tap to copy)</Text>
                    </Pressable>
                  </View>
                )}
                <TextInput
                  style={styles.input}
                  placeholder="Friend’s Username"
                  placeholderTextColor="#8B949E"
                  value={friendCode}
                  onChangeText={setFriendCode}
                  autoCapitalize="words"
                  autoCorrect={false}
                />
                <View style={styles.startMatchRow}>
                  <StyledButton
                    label={creatingMatch ? 'Starting…' : 'Start Match'}
                    onPress={handleCreateMatch}
                    disabled={creatingMatch || !userId}
                    style={[styles.primaryButton, styles.startMatchGreen, styles.startMatchSingleButton]}
                    textStyle={styles.startMatchGreenText}
                  />
                </View>
                <View style={styles.startMatchRow}>
                  <StyledButton
                    label="Refresh Challenges"
                    onPress={refreshChallenges}
                    style={[styles.primaryButton, styles.openMatchYourTurn, { flex: 1 }]}
                    textStyle={styles.openMatchYourTurnText}
                  />
                </View>
                {createMessage && <Text style={styles.shareHint}>{createMessage}</Text>}
              </View>

              {loadingGames ? (
                <View style={styles.loadingMatches}>
                  <ActivityIndicator size="small" color="#FE9902" />
                  <Text style={styles.loadingText}>Loading matches…</Text>
                </View>
              ) : (
                <>
                  {renderSection('Challenges', sections.challenges, 'No new challenges yet.')}
                  {renderSplitSection(
                    'Your Turn',
                    friendYourTurnGames,
                    randomYourTurnGames,
                    'No games where it’s your turn yet.'
                  )}
                  {renderSplitSection(
                    'Their Turn',
                    friendTheirTurnGames,
                    randomTheirTurnGames,
                    'No games waiting on your friends.'
                  )}
                  {renderSplitSection(
                    'Completed games',
                    friendCompletedGames,
                    randomCompletedGames,
                    'No completed games yet.'
                  )}
                </>
              )}
            </View>

            <View style={styles.flexSpacer} />

            <Link href="/" asChild>
              <Pressable style={styles.mainMenuButton}>
                <Text style={styles.mainMenuButtonText}>Menu</Text>
              </Pressable>
            </Link>
            {Platform.OS === 'ios' ? (
              <Pressable
                style={[styles.mainMenuButton, styles.refreshButton]}
                onPress={onClearBadge}
              >
                <Text style={styles.mainMenuButtonText}>Clear Notifications</Text>
              </Pressable>
            ) : Platform.OS === 'android' ? (
              <Pressable
                style={[styles.mainMenuButton, styles.refreshButton]}
                onPress={handleClearAndroidBadges}
              >
                <Text style={styles.mainMenuButtonText}>Clear Notifications</Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </FeltBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#1F262A',
    paddingTop: 25,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 40,
  },
  innerContent: {
    flex: 1,
    alignItems: 'center',
  },
  pageContent: {
    width: '100%',
    maxWidth: 520,
  },
  flexSpacer: {
    flexGrow: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F262A',
  },
  loadingText: {
    marginTop: 12,
    color: '#F0F6FC',
    fontSize: 16,
  },
  card: {
    backgroundColor: '#2A3136',
    borderRadius: 16,
    padding: 16,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#30363D',
  },
  cardTitle: {
    color: '#FE9902',
    fontWeight: '800',
    fontSize: 18,
    marginBottom: 4,
    textAlign: 'center',
  },
  cardSubtitle: {
    color: '#8B949E',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#30363D',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F0F6FC',
    marginBottom: 12,
    textAlign: 'center',
  },
  primaryButton: {
    marginBottom: 6,
  },
  startMatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: 12,
  },
  startMatchGreen: {
    backgroundColor: '#53A7F3',
    borderColor: '#1C75BC',
    borderWidth: 2,
  },
  startMatchSingleButton: {
    flex: 1,
  },
  startMatchGreenText: {
    color: '#F0F6FC',
    fontWeight: '800',
  },
  refreshButton: {
    backgroundColor: '#B33636',
    borderColor: '#7A2424',
    borderWidth: 2,
  },
  refreshButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  shareHint: {
    color: '#8B949E',
    fontSize: 13,
    marginTop: 6,
  },
  yourCode: {
    color: '#8B949E',
    fontSize: 13,
    marginBottom: 8,
  },
  yourCodeValue: {
    color: '#FE9902',
    fontWeight: '800',
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  usernameLabel: {
    fontSize: 14,
    color: '#C9D1D9',
    marginRight: 4,
  },
  usernamePressable: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  usernameValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FE9902',
    marginRight: 6,
  },
  usernameHint: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  section: {
    width: '100%',
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#FE9902',
    fontWeight: '800',
    fontSize: 18,
    marginBottom: 10,
    textAlign: 'center',
  },
  sectionSubTitle: {
    color: '#8B949E',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 6,
    marginBottom: 4,
    textAlign: 'center',
  },
  emptyTextSmall: {
    color: '#8B949E',
    textAlign: 'center',
    fontSize: 13,
  },
  gameCard: {
    backgroundColor: '#2A3136',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#30363D',
  },
  gameCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  gameOpponentColumn: {
    flexDirection: 'column',
  },
  currentClaimContainer: {
    alignItems: 'flex-end',
  },
  currentClaimLabel: {
    color: '#8B949E',
    fontSize: 11,
    marginBottom: 2,
  },
  currentClaimDiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currentClaimDie: {
    transform: [{ scale: CURRENT_CLAIM_DIE_SCALE }],
  },
  gameOpponent: {
    color: '#F0F6FC',
    fontWeight: '700',
    fontSize: 16,
  },
  randomBadgeText: {
    color: '#53A7F3',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  gameStatus: {
    color: '#8B949E',
    fontSize: 13,
  },
  gameScore: {
    color: '#F0F6FC',
    marginBottom: 10,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  completedOutcomeContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  completedOutcomeText: {
    color: '#F0F6FC',
    fontSize: 14,
    fontWeight: '700',
  },
  openMatchButton: {
    flex: 1,
    marginRight: 12,
  },
  openMatchYourTurn: {
    backgroundColor: '#FE9902',
    borderColor: '#C76E00',
    borderWidth: 2,
  },
  openMatchYourTurnText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  swipeDeleteContainer: {
    width: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  swipeDeleteButton: {
    width: 56,
    height: '70%',
    backgroundColor: '#8B0000',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  swipeDeleteText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  loadingMatches: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  mainMenuButton: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#53A7F3',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#1C75BC',
    marginTop: 16,
  },
  mainMenuButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
