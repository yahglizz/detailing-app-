import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts, LeagueSpartan_800ExtraBold, LeagueSpartan_900Black } from '@expo-google-fonts/league-spartan';
import { View } from 'react-native';
import { colors } from './src/theme';
import { OrderProvider } from './src/state/order';
import { CatalogProvider } from './src/state/catalog';
import { MemberProvider } from './src/state/member';
import { AppearanceProvider } from './src/state/appearance';
import Home from './src/screens/Home';
import Build from './src/screens/Build';
import Booked from './src/screens/Booked';
import MemberCode from './src/screens/MemberCode';
import MemberDashboard from './src/screens/MemberDashboard';
import MemberSettings from './src/screens/MemberSettings';
import TopUp from './src/screens/TopUp';

export type RootStackParamList = {
  Home: undefined;
  Build: undefined;
  Booked: { bookingId: string; escalated?: boolean; paid?: 'deposit' | 'full' | 'credit' | 'balance'; stamps?: number; saved?: number };
  MemberCode: undefined;
  MemberDashboard: undefined;
  MemberSettings: undefined;
  TopUp: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [loaded] = useFonts({ LeagueSpartan_800ExtraBold, LeagueSpartan_900Black });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <CatalogProvider>
      <MemberProvider>
        <AppearanceProvider>
        <OrderProvider>
          <NavigationContainer theme={{ ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg } }}>
            <Stack.Navigator
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                headerTitleStyle: { fontFamily: 'LeagueSpartan_800ExtraBold' },
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="Home" component={Home} options={{ headerShown: false }} />
              <Stack.Screen name="Build" component={Build} options={{ headerShown: false }} />
              <Stack.Screen name="Booked" component={Booked} options={{ headerShown: false, gestureEnabled: false }} />
              <Stack.Screen name="MemberCode" component={MemberCode} options={{ headerShown: false }} />
              <Stack.Screen name="MemberDashboard" component={MemberDashboard} options={{ headerShown: false, headerBackVisible: false }} />
              <Stack.Screen name="MemberSettings" component={MemberSettings} options={{ headerShown: false }} />
              <Stack.Screen name="TopUp" component={TopUp} options={{ headerShown: false }} />
            </Stack.Navigator>
          </NavigationContainer>
        </OrderProvider>
        </AppearanceProvider>
      </MemberProvider>
    </CatalogProvider>
  );
}
