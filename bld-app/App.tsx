import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts, LeagueSpartan_800ExtraBold, LeagueSpartan_900Black } from '@expo-google-fonts/league-spartan';
import { View } from 'react-native';
import { colors } from './src/theme';
import { OrderProvider } from './src/state/order';
import { CatalogProvider } from './src/state/catalog';
import Home from './src/screens/Home';
import Build from './src/screens/Build';
import Schedule from './src/screens/Schedule';
import Pay from './src/screens/Pay';
import Booked from './src/screens/Booked';

export type RootStackParamList = {
  Home: undefined;
  Build: undefined;
  Schedule: undefined;
  Pay: undefined;
  Booked: { bookingId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [loaded] = useFonts({ LeagueSpartan_800ExtraBold, LeagueSpartan_900Black });
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <CatalogProvider>
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
            <Stack.Screen name="Build" component={Build} options={{ title: 'BUILD YOUR DETAIL' }} />
            <Stack.Screen name="Schedule" component={Schedule} options={{ title: 'WHEN & WHERE' }} />
            <Stack.Screen name="Pay" component={Pay} options={{ title: 'PAY DEPOSIT' }} />
            <Stack.Screen name="Booked" component={Booked} options={{ headerShown: false, gestureEnabled: false }} />
          </Stack.Navigator>
        </NavigationContainer>
      </OrderProvider>
    </CatalogProvider>
  );
}
