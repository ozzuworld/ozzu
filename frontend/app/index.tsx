import { Redirect } from "expo-router";

// Root URL "/" → redirect to home tab
export default function Index() {
  return <Redirect href="/home" />;
}
