// App.js
// App.js
import React, { useState, useEffect, useContext } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  TextInput,
  Alert,
  Linking,
  ActivityIndicator,
  Switch,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { MaterialIcons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';

// Native health integrations
import AppleHealthKit from 'react-native-health';
import GoogleFit, { Scopes } from 'react-native-google-fit';

const Drawer = createDrawerNavigator();

/* =======================================
   CONFIG: Backend + Shopify
   ======================================= */

/**
 * Backend for Fitbit/Oura aggregated data.
 * TODO: replace with your deployed API base URL, e.g. 'https://api.pulseapp.com'
 */
const API_BASE_URL = 'https://YOUR_BACKEND_URL_HERE';

/**
 * Shopify Storefront configuration
 * TODO:
 *  - Confirm SHOPIFY_DOMAIN (kinisiapparel.net or your myshopify.com domain)
 *  - Replace STOREFRONT_ACCESS_TOKEN with your Storefront API token
 */
const SHOPIFY_DOMAIN = 'kinisiapparel.net';
const STOREFRONT_ACCESS_TOKEN = 'YOUR_STOREFRONT_ACCESS_TOKEN_HERE';
const STOREFRONT_API_VERSION = '2024-01';

const STOREFRONT_ENDPOINT = `https://${SHOPIFY_DOMAIN}/api/${STOREFRONT_API_VERSION}/graphql.json`;

const PRODUCTS_QUERY = `
  query PulseProducts($numProducts: Int!) {
    products(first: $numProducts, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          description
          onlineStoreUrl
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

/* =======================================
   Health sync helpers
   ======================================= */

// ====== Apple Health sync (iOS) ======
async function syncFromAppleHealth() {
  if (Platform.OS !== 'ios') {
    throw new Error('Apple Health is only available on iOS.');
  }

  const permissions = {
    permissions: {
      read: [
        AppleHealthKit.Constants.Permissions.StepCount,
        AppleHealthKit.Constants.Permissions.Workout,
        AppleHealthKit.Constants.Permissions.HeartRate,
      ],
      write: [],
    },
  };

  return new Promise((resolve, reject) => {
    AppleHealthKit.initHealthKit(permissions, (error) => {
      if (error) {
        reject(new Error('Apple Health permission was not granted.'));
        return;
      }

      const today = new Date();
      const start = new Date();
      start.setDate(today.getDate() - 6); // last 7 days

      const options = {
        startDate: start.toISOString(),
        endDate: today.toISOString(),
      };

      AppleHealthKit.getDailyStepCountSamples(options, (err, results) => {
        if (err || !results) {
          reject(new Error('Unable to read steps from Apple Health.'));
          return;
        }

        const byDate = {};

        results.forEach((sample) => {
          const d = new Date(sample.startDate);
          const dateKey = d.toISOString().slice(0, 10);
          byDate[dateKey] = (byDate[dateKey] || 0) + (sample.value || 0);
        });

        const weekly = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(today.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          weekly.push({
            date: key,
            steps: byDate[key] || 0,
            label: d.toLocaleDateString(undefined, { weekday: 'short' }),
          });
        }

        const todayKey = today.toISOString().slice(0, 10);
        resolve({
          stepsToday: byDate[todayKey] || 0,
          weeklySteps: weekly,
          lastSource: 'Apple Health',
        });
      });
    });
  });
}

// ====== Google Fit sync (Android) ======
async function syncFromGoogleFit() {
  if (Platform.OS !== 'android') {
    throw new Error('Google Fit is only available on Android.');
  }

  const options = {
    scopes: [
      Scopes.FITNESS_ACTIVITY_READ,
      Scopes.FITNESS_ACTIVITY_READ_WRITE,
    ],
  };

  const authResult = await GoogleFit.authorize(options);
  if (!authResult.success) {
    throw new Error('Google Fit permission was not granted.');
  }

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);

  const stepsOptions = {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };

  const res = await GoogleFit.getDailyStepCountSamples(stepsOptions);
  const googleSource =
    res.find((r) => r.source === 'com.google.android.gms:estimated_steps') ||
    res[0];

  const byDate = {};
  (googleSource?.steps || []).forEach((s) => {
    const d = new Date(s.startDate || s.date);
    const dateKey = d.toISOString().slice(0, 10);
    byDate[dateKey] = (byDate[dateKey] || 0) + (s.value || 0);
  });

  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    weekly.push({
      date: key,
      steps: byDate[key] || 0,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
    });
  }

  const todayKey = end.toISOString().slice(0, 10);
  return {
    stepsToday: byDate[todayKey] || 0,
    weeklySteps: weekly,
    lastSource: 'Google Fit',
  };
}

// ====== Fitbit / Oura via backend ======
async function syncFromBackend(sourceKey) {
  if (!API_BASE_URL || API_BASE_URL.includes('YOUR_BACKEND_URL_HERE')) {
    throw new Error(
      `${sourceKey} backend not configured. Set API_BASE_URL to your backend URL.`
    );
  }

  const res = await fetch(
    `${API_BASE_URL}/summary?source=${encodeURIComponent(sourceKey)}`
  );
  if (!res.ok) {
    throw new Error('Unable to fetch summary from backend.');
  }
  const json = await res.json();

  if (
    typeof json.stepsToday !== 'number' ||
    !Array.isArray(json.weeklySteps)
  ) {
    throw new Error('Backend summary response is not in the expected format.');
  }

  return {
    stepsToday: json.stepsToday,
    weeklySteps: json.weeklySteps,
    lastSource: json.lastSource || sourceKey,
  };
}

/* =======================================
   Activity context (Dashboard <-> Tracker)
   ======================================= */

const ActivityContext = React.createContext({
  activitySummary: null,            // { stepsToday, weeklySteps, lastSource }
  setActivitySummary: () => {},     // replaced in Provider
});

/* ============================
   UI Components – logo, cards, charts
   ============================ */

const PulseHeaderTitle = () => (
  <Text style={styles.headerLogoText}>Pulse</Text>
);

const SectionTitle = ({ children }) => (
  <Text style={styles.sectionTitle}>{children}</Text>
);

const Card = ({ children, style }) => (
  <View style={[styles.card, style]}>{children}</View>
);

// Progress ring for daily steps goal
const ProgressRing = ({ progress = 0, size = 120, strokeWidth = 10 }) => {
  const clamped = Math.max(0, Math.min(progress, 1));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - clamped);

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size} height={size}>
        {/* Background track */}
        <Circle
          stroke="#1f2937"
          fill="none"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <Circle
          stroke="#facc15"
          fill="none"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          rotation="-90"
          originX={size / 2}
          originY={size / 2}
        />
      </Svg>
      <View
        style={[
          StyleSheet.absoluteFillObject,
          { alignItems: 'center', justifyContent: 'center' },
        ]}
      >
        <Text style={{ color: '#f9fafb', fontWeight: '700', fontSize: 18 }}>
          {Math.round(clamped * 100)}%
        </Text>
        <Text style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
          of daily goal
        </Text>
      </View>
    </View>
  );
};

// Weekly steps bar chart
const WeeklyStepsChart = ({ data }) => {
  if (!data || data.length === 0) {
    return (
      <Text style={styles.cardBody}>
        Once you sync from any source, your last 7 days of steps will show here.
      </Text>
    );
  }

  const maxSteps = Math.max(...data.map((d) => d.steps), 1);

  return (
    <View style={{ marginTop: 12 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        {data.map((d) => {
          const height = (d.steps / maxSteps) * 80; // up to 80px bar height
          return (
            <View
              key={d.date}
              style={{ flex: 1, alignItems: 'center', marginHorizontal: 4 }}
            >
              <View
                style={{
                  width: 10,
                  height: Math.max(8, height),
                  borderRadius: 999,
                  backgroundColor: '#facc15',
                }}
              />
              <Text
                style={{
                  color: '#9ca3af',
                  fontSize: 11,
                  marginTop: 4,
                }}
              >
                {d.label}
              </Text>
              <Text
                style={{
                  color: '#6b7280',
                  fontSize: 10,
                  marginTop: 2,
                }}
              >
                {d.steps > 0 ? (d.steps / 1000).toFixed(1) + 'k' : ''}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
};

/* ============================
   Dashboard / Home
   ============================ */

function DashboardScreen({ navigation }) {
  const { activitySummary } = useContext(ActivityContext);

  // Defaults
  let minutesMoved = 0;
  let workoutsThisWeek = 0;
  let habitsCompletedText = '0/7';
  let totalWeeklySteps = 0;
  let stepsTodayValue = 0;

  if (activitySummary) {
    const stepsToday = activitySummary.stepsToday || 0;
    const weeklySteps = Array.isArray(activitySummary.weeklySteps)
      ? activitySummary.weeklySteps
      : [];

    stepsTodayValue = stepsToday;

    // Approx: 100 steps ≈ 1 minute
    minutesMoved = Math.round(stepsToday / 100);

    // A "workout day" = 6000+ steps
    workoutsThisWeek = weeklySteps.filter((d) => d.steps >= 6000).length;

    // A "habit completed" day = 3000+ steps
    const habitDays = weeklySteps.filter((d) => d.steps >= 3000).length;
    habitsCompletedText = `${habitDays}/7`;

    // Total steps this week
    totalWeeklySteps = weeklySteps.reduce((sum, d) => sum + d.steps, 0);
  }

  const dailyGoal = 10000;
  const progress = stepsTodayValue > 0 ? stepsTodayValue / dailyGoal : 0;

  // Badge conditions
  const badges = [];
  if (stepsTodayValue >= 6000) {
    badges.push({ icon: '🏅', label: 'Active day' });
  }
  if (stepsTodayValue >= dailyGoal) {
    badges.push({ icon: '🔥', label: 'Goal reached' });
  }
  if (workoutsThisWeek >= 3) {
    badges.push({ icon: '📈', label: 'Consistency streak' });
  }
  if (totalWeeklySteps >= 50000) {
    badges.push({ icon: '💪', label: 'Weekly grinder' });
  }

  return (
    <SafeAreaView style={styles.screenContainer}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.screenScroll}>
        <Text style={styles.eyebrow}>Welcome back</Text>
        <Text style={styles.heroTitle}>Your Pulse for today</Text>
        <Text style={styles.heroSubtitle}>
          Track your movement, clear your mind, and fuel your lifestyle — all in one place.
        </Text>

        {/* Snapshot + badges */}
        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>Today’s snapshot</Text>

          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {minutesMoved > 0 ? minutesMoved : '--'}
              </Text>
              <Text style={styles.metricLabel}>Minutes moved</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {workoutsThisWeek > 0 ? workoutsThisWeek : '--'}
              </Text>
              <Text style={styles.metricLabel}>Workouts this week</Text>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>{habitsCompletedText}</Text>
              <Text style={styles.metricLabel}>Habits completed</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>💧</Text>
              <Text style={styles.metricLabel}>Hydration on track</Text>
            </View>
          </View>

          {/* Total weekly steps */}
          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>
                {totalWeeklySteps > 0
                  ? totalWeeklySteps.toLocaleString()
                  : '--'}
              </Text>
              <Text style={styles.metricLabel}>Total steps this week</Text>
            </View>
          </View>

          {/* Badges */}
          {badges.length > 0 && (
            <View style={styles.badgeRow}>
              {badges.map((b, idx) => (
                <View key={idx} style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {b.icon} {b.label}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => navigation.navigate('Workouts')}
          >
            <Text style={styles.primaryButtonText}>Start quick workout</Text>
          </TouchableOpacity>
        </Card>

        {/* Daily goal progress ring */}
        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>Daily goal</Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 12,
            }}
          >
            <ProgressRing progress={progress} />
            <View style={{ marginLeft: 16, flex: 1 }}>
              <Text style={styles.cardTitle}>
                {stepsTodayValue > 0
                  ? `${stepsTodayValue.toLocaleString()} steps`
                  : 'No data yet'}
              </Text>
              <Text style={styles.cardBody}>
                Your target is {dailyGoal.toLocaleString()} steps per day. Sync from
                your tracker and watch this ring fill as you move.
              </Text>
            </View>
          </View>
        </Card>

        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>This week’s focus</Text>
          <Text style={styles.cardBody}>
            Strength & recovery — aim for 3 strength sessions, 2 active recovery days,
            and a few minutes of reflection journaling after each workout.
          </Text>
        </Card>

        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>Shortcuts</Text>
          <View style={styles.chipRow}>
            <TouchableOpacity
              style={styles.chip}
              onPress={() => navigation.navigate('Workouts')}
            >
              <Text style={styles.chipText}>Open Workouts</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.chip}
              onPress={() => navigation.navigate('Journal')}
            >
              <Text style={styles.chipText}>Write Journal</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.chip}
              onPress={() => navigation.navigate('Tracker')}
            >
              <Text style={styles.chipText}>View Tracker</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.chip}
              onPress={() => navigation.navigate('Shop')}
            >
              <Text style={styles.chipText}>Open Shop</Text>
            </TouchableOpacity>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ============================
   Workouts
   ============================ */

function WorkoutsScreen() {
  const sampleWorkouts = [
    {
      title: 'Full Body Ignite',
      level: 'Intermediate • 35 min',
      focus: 'Strength · Conditioning',
    },
    {
      title: 'Morning Mobility Flow',
      level: 'All levels • 15 min',
      focus: 'Mobility · Recovery',
    },
    {
      title: 'Lower Body Power',
      level: 'Advanced • 40 min',
      focus: 'Legs · Glutes',
    },
  ];

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.screenScroll}>
        <SectionTitle>Workout plans</SectionTitle>
        <Text style={styles.sectionSubtitle}>
          Curated sessions to match your energy and schedule. Choose one to begin.
        </Text>

        {sampleWorkouts.map((w, idx) => (
          <Card key={idx} style={{ marginTop: 20 }}>
            <Text style={styles.cardTitle}>{w.title}</Text>
            <Text style={styles.cardMeta}>{w.level}</Text>
            <Text style={styles.cardBody}>{w.focus}</Text>
            <TouchableOpacity style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>View details</Text>
            </TouchableOpacity>
          </Card>
        ))}

        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>Coming soon</Text>
          <Text style={styles.cardBody}>
            In the full Pulse app, this screen would pull your personalized workout calendar,
            saved programs, and recommended sessions based on your training history.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ============================
   Journal
   ============================ */

function JournalScreen() {
  const [entry, setEntry] = useState('');
  const [savedEntry, setSavedEntry] = useState('');

  const handleSave = () => {
    const trimmed = entry.trim();
    if (!trimmed) {
      Alert.alert('Empty entry', 'Write something before saving your reflection.');
      return;
    }
    setSavedEntry(trimmed);
    Alert.alert('Saved', 'Your journal entry has been saved for today.');
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView
        contentContainerStyle={styles.screenScroll}
        keyboardShouldPersistTaps="handled"
      >
        <SectionTitle>Mindset journal</SectionTitle>
        <Text style={styles.sectionSubtitle}>
          Reflect on your workout, your energy, and your wins today.
        </Text>

        <Card style={{ marginTop: 20 }}>
          <Text style={styles.cardLabel}>Today’s reflection</Text>
          <TextInput
            style={styles.journalInput}
            placeholder="How did your body feel today? What are you proud of?"
            placeholderTextColor="#6b7280"
            multiline
            value={entry}
            onChangeText={setEntry}
          />
          <TouchableOpacity style={styles.primaryButton} onPress={handleSave}>
            <Text style={styles.primaryButtonText}>Save entry</Text>
          </TouchableOpacity>
        </Card>

        {savedEntry ? (
          <Card style={{ marginTop: 24 }}>
            <Text style={styles.cardLabel}>Last saved</Text>
            <Text style={styles.cardBody}>{savedEntry}</Text>
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ============================
   Tracker – real sync hooks + bar chart
   ============================ */

function TrackerScreen() {
  const { setActivitySummary } = useContext(ActivityContext);

  const [appleHealthConnected, setAppleHealthConnected] = useState(false);
  const [googleFitConnected, setGoogleFitConnected] = useState(false);
  const [fitbitConnected, setFitbitConnected] = useState(false);
  const [ouraConnected, setOuraConnected] = useState(false);

  const [stepsToday, setStepsToday] = useState(0);
  const [weeklySteps, setWeeklySteps] = useState([]); // [{date, label, steps}]
  const [lastSource, setLastSource] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');

  const updateFromResult = (result) => {
    const summary = {
      stepsToday: result.stepsToday || 0,
      weeklySteps: result.weeklySteps || [],
      lastSource: result.lastSource || null,
    };

    setStepsToday(summary.stepsToday);
    setWeeklySteps(summary.weeklySteps);
    setLastSource(summary.lastSource);

    // share with dashboard
    setActivitySummary(summary);
  };

  const handleAppleToggle = async (value) => {
    setAppleHealthConnected(value);
    if (!value) return;

    try {
      setSyncError('');
      setSyncing(true);
      const result = await syncFromAppleHealth();
      updateFromResult(result);
    } catch (e) {
      setSyncError(e.message || 'Apple Health sync failed.');
      setAppleHealthConnected(false);
    } finally {
      setSyncing(false);
    }
  };

  const handleGoogleToggle = async (value) => {
    setGoogleFitConnected(value);
    if (!value) return;

    try {
      setSyncError('');
      setSyncing(true);
      const result = await syncFromGoogleFit();
      updateFromResult(result);
    } catch (e) {
      setSyncError(e.message || 'Google Fit sync failed.');
      setGoogleFitConnected(false);
    } finally {
      setSyncing(false);
    }
  };

  const handleFitbitToggle = async (value) => {
    setFitbitConnected(value);
    if (!value) return;

    try {
      setSyncError('');
      setSyncing(true);
      const result = await syncFromBackend('fitbit');
      updateFromResult(result);
    } catch (e) {
      setSyncError(e.message || 'Fitbit sync failed.');
      setFitbitConnected(false);
    } finally {
      setSyncing(false);
    }
  };

  const handleOuraToggle = async (value) => {
    setOuraConnected(value);
    if (!value) return;

    try {
      setSyncError('');
      setSyncing(true);
      const result = await syncFromBackend('oura');
      updateFromResult(result);
    } catch (e) {
      setSyncError(e.message || 'Oura sync failed.');
      setOuraConnected(false);
    } finally {
      setSyncing(false);
    }
  };

  const handleRefresh = async () => {
    try {
      setSyncError('');
      setSyncing(true);

      if (appleHealthConnected) {
        const result = await syncFromAppleHealth();
        updateFromResult(result);
      } else if (googleFitConnected) {
        const result = await syncFromGoogleFit();
        updateFromResult(result);
      } else if (fitbitConnected) {
        const result = await syncFromBackend('fitbit');
        updateFromResult(result);
      } else if (ouraConnected) {
        const result = await syncFromBackend('oura');
        updateFromResult(result);
      } else {
        setSyncError('Connect at least one source to refresh data.');
      }
    } catch (e) {
      setSyncError(e.message || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.screenScroll}>
        <SectionTitle>Activity tracker</SectionTitle>
        <Text style={styles.sectionSubtitle}>
          Connect your devices and see your real movement data in one place.
        </Text>

        {/* Today summary */}
        <Card style={{ marginTop: 20 }}>
          <Text style={styles.cardLabel}>Today</Text>
          {syncing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
              <ActivityIndicator size="small" />
              <Text style={[styles.cardBody, { marginLeft: 8 }]}>
                Syncing your latest data…
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.cardTitle}>
                {stepsToday > 0
                  ? `${stepsToday.toLocaleString()} steps`
                  : 'No data yet'}
              </Text>
              <Text style={styles.cardBody}>
                {lastSource
                  ? `Last synced from ${lastSource}.`
                  : 'Connect at least one source below to start syncing.'}
              </Text>
            </>
          )}

          {syncError ? (
            <Text style={[styles.cardBody, { color: '#fca5a5', marginTop: 8 }]}>
              {syncError}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[styles.secondaryButton, { marginTop: 12 }]}
            onPress={handleRefresh}
          >
            <Text style={styles.secondaryButtonText}>Refresh data</Text>
          </TouchableOpacity>
        </Card>

        {/* Weekly overview with bar chart */}
        <Card style={{ marginTop: 20 }}>
          <Text style={styles.cardLabel}>Last 7 days</Text>
          <WeeklyStepsChart data={weeklySteps} />
        </Card>

        {/* Device connections */}
        <Card style={{ marginTop: 24 }}>
          <Text style={styles.cardLabel}>Connect your devices</Text>

          <View style={styles.deviceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>Apple Health (Apple Watch)</Text>
              <Text style={styles.deviceSubtitle}>
                iOS — reads steps, workouts, and heart rate from Apple Health.
              </Text>
            </View>
            <Switch
              value={appleHealthConnected}
              onValueChange={handleAppleToggle}
            />
          </View>

          <View style={styles.deviceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>Google Fit</Text>
              <Text style={styles.deviceSubtitle}>
                Android — reads your activity directly from Google Fit.
              </Text>
            </View>
            <Switch
              value={googleFitConnected}
              onValueChange={handleGoogleToggle}
            />
          </View>

          <View style={styles.deviceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>Fitbit</Text>
              <Text style={styles.deviceSubtitle}>
                Uses your Pulse backend to securely import Fitbit steps, sleep, and workouts.
              </Text>
            </View>
            <Switch
              value={fitbitConnected}
              onValueChange={handleFitbitToggle}
            />
          </View>

          <View style={styles.deviceRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>Oura Ring</Text>
              <Text style={styles.deviceSubtitle}>
                Uses your Pulse backend to bring in readiness and sleep insights.
              </Text>
            </View>
            <Switch
              value={ouraConnected}
              onValueChange={handleOuraToggle}
            />
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ============================
   Shopify-powered Shop
   ============================ */

function ShopScreen() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  const fetchProducts = async () => {
    try {
      setLoading(true);
      setErrorMessage('');

      if (
        !SHOPIFY_DOMAIN ||
        !STOREFRONT_ACCESS_TOKEN ||
        STOREFRONT_ACCESS_TOKEN === 'YOUR_STOREFRONT_ACCESS_TOKEN_HERE'
      ) {
        throw new Error(
          'The shop is not fully connected yet. Products are currently unavailable.'
        );
      }

      const response = await fetch(STOREFRONT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query: PRODUCTS_QUERY,
          variables: { numProducts: 10 },
        }),
      });

      if (!response.ok) {
        throw new Error('Unable to load products. Please try again later.');
      }

      const json = await response.json();

      if (json.errors && json.errors.length > 0) {
        throw new Error('There was a problem loading products.');
      }

      const edges = json?.data?.products?.edges ?? [];
      const mapped = edges.map(({ node }) => {
        const minPrice = node?.priceRange?.minVariantPrice;
        const amount = minPrice?.amount
          ? Number(minPrice.amount).toFixed(2)
          : null;
        const currency = minPrice?.currencyCode ?? 'USD';

        return {
          id: node.id,
          name: node.title,
          tag: node.description?.trim() || 'Product',
          price: amount ? `${currency} ${amount}` : 'See product',
          url:
            node.onlineStoreUrl ||
            `https://${SHOPIFY_DOMAIN}/products/${node.handle}`,
        };
      });

      setProducts(mapped);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to load products.');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const handlePurchasePress = (product) => {
    Alert.alert(
      'Continue to store?',
      `You’ll complete your purchase for “${product.name}” in a secure browser window.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            Linking.openURL(product.url).catch(() => {
              Alert.alert(
                'Error',
                'Unable to open the product page. Please check your connection and try again.'
              );
            });
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.screenScroll}>
        <SectionTitle>Pulse Shop</SectionTitle>
        <Text style={styles.sectionSubtitle}>
          Lifestyle products and training essentials powered by your Shopify store.
        </Text>

        {loading && (
          <View style={{ marginTop: 24, alignItems: 'center' }}>
            <ActivityIndicator size="large" />
            <Text style={{ color: '#9ca3af', marginTop: 12 }}>
              Loading products…
            </Text>
          </View>
        )}

        {!loading && errorMessage ? (
          <Card style={{ marginTop: 24 }}>
            <Text style={styles.cardLabel}>Shop offline</Text>
            <Text style={styles.cardBody}>{errorMessage}</Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={fetchProducts}
            >
              <Text style={styles.secondaryButtonText}>Try again</Text>
            </TouchableOpacity>
          </Card>
        ) : null}

        {!loading &&
          !errorMessage &&
          products.map((p) => (
            <Card key={p.id} style={{ marginTop: 20 }}>
              <Text style={styles.cardTitle}>{p.name}</Text>
              <Text style={styles.cardMeta}>{p.tag}</Text>
              <Text style={styles.cardPrice}>{p.price}</Text>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => handlePurchasePress(p)}
              >
                <Text style={styles.secondaryButtonText}>
                  View & buy on store
                </Text>
              </TouchableOpacity>
            </Card>
          ))}

        {!loading && !errorMessage && products.length === 0 && (
          <Card style={{ marginTop: 24 }}>
            <Text style={styles.cardLabel}>No products yet</Text>
            <Text style={styles.cardBody}>
              Your shop is connected but no products are available. Once you publish
              products in your Shopify admin, they’ll show up here automatically.
            </Text>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ============================
   Main App with Drawer Nav + ActivityContext
   ============================ */

export default function App() {
  const [activitySummary, setActivitySummary] = useState(null);

  return (
    <ActivityContext.Provider value={{ activitySummary, setActivitySummary }}>
      <NavigationContainer>
        <Drawer.Navigator
          initialRouteName="Dashboard"
          screenOptions={{
            headerTitle: () => <PulseHeaderTitle />,
            headerStyle: {
              backgroundColor: '#020617',
            },
            headerTintColor: '#f9fafb',
            drawerActiveTintColor: '#facc15',
            drawerInactiveTintColor: '#9ca3af',
            drawerStyle: {
              backgroundColor: '#020617',
            },
            sceneContainerStyle: {
              backgroundColor: '#020617',
            },
          }}
        >
          <Drawer.Screen
            name="Dashboard"
            component={DashboardScreen}
            options={{
              drawerIcon: ({ color, size }) => (
                <MaterialIcons name="dashboard" color={color} size={size} />
              ),
            }}
          />
          <Drawer.Screen
            name="Workouts"
            component={WorkoutsScreen}
            options={{
              drawerIcon: ({ color, size }) => (
                <MaterialIcons name="fitness-center" color={color} size={size} />
              ),
            }}
          />
          <Drawer.Screen
            name="Journal"
            component={JournalScreen}
            options={{
              drawerIcon: ({ color, size }) => (
                <MaterialIcons name="edit-note" color={color} size={size} />
              ),
            }}
          />
          <Drawer.Screen
            name="Tracker"
            component={TrackerScreen}
            options={{
              drawerIcon: ({ color, size }) => (
                <MaterialIcons name="show-chart" color={color} size={size} />
              ),
            }}
          />
          <Drawer.Screen
            name="Shop"
            component={ShopScreen}
            options={{
              drawerIcon: ({ color, size }) => (
                <MaterialIcons name="shopping-bag" color={color} size={size} />
              ),
            }}
          />
        </Drawer.Navigator>
      </NavigationContainer>
    </ActivityContext.Provider>
  );
}

/* ============================
   Styles
   ============================ */

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: '#020617',
  },
  screenScroll: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  headerLogoText: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: '#facc15',
  },
  eyebrow: {
    fontSize: 14,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f9fafb',
    marginTop: 4,
  },
  heroSubtitle: {
    fontSize: 15,
    color: '#9ca3af',
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f9fafb',
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#9ca3af',
    marginTop: 8,
  },
  card: {
    backgroundColor: '#020617',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#111827',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
  cardLabel: {
    fontSize: 13,
    color: '#a5b4fc',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 18,
    color: '#f9fafb',
    fontWeight: '600',
  },
  cardMeta: {
    fontSize: 13,
    color: '#9ca3af',
    marginTop: 4,
  },
  cardBody: {
    fontSize: 14,
    color: '#d1d5db',
    marginTop: 8,
    lineHeight: 20,
  },
  cardPrice: {
    fontSize: 16,
    color: '#facc15',
    fontWeight: '600',
    marginTop: 8,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  metric: {
    flex: 1,
    marginRight: 8,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f9fafb',
  },
  metricLabel: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 4,
  },
  primaryButton: {
    marginTop: 16,
    backgroundColor: '#facc15',
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#1f2933',
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryButton: {
    marginTop: 12,
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4b5563',
  },
  secondaryButtonText: {
    color: '#e5e7eb',
    fontWeight: '600',
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4b5563',
    marginRight: 8,
    marginTop: 8,
  },
  chipText: {
    color: '#e5e7eb',
    fontSize: 13,
    fontWeight: '500',
  },
  journalInput: {
    minHeight: 120,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#374151',
    padding: 12,
    color: '#e5e7eb',
    fontSize: 14,
    marginTop: 8,
    textAlignVertical: 'top',
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  badge: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4b5563',
    marginRight: 8,
    marginTop: 8,
    backgroundColor: '#111827',
  },
  badgeText: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '500',
  },
  trackerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  trackerDay: {
    width: 40,
    color: '#9ca3af',
    fontSize: 13,
  },
  trackerBarWrapper: {
    flex: 1,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#111827',
    overflow: 'hidden',
    marginHorizontal: 8,
  },
  trackerBar: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#facc15',
  },
  trackerMinutes: {
    width: 80,
    fontSize: 12,
    color: '#e5e7eb',
    textAlign: 'right',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  deviceName: {
    fontSize: 14,
    color: '#f9fafb',
    fontWeight: '600',
  },
  deviceSubtitle: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
});
