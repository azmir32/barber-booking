import { Redirect } from 'expo-router';

// A link to a page that doesn't exist goes to the start, which sends
// people on to the right home.
export default function NotFound() {
  return <Redirect href="/" />;
}
