/**
 * @flowcache/dashboard — App.tsx
 *
 * Thin root component. Kept separate from `pages/Overview.tsx` so
 * adding more pages/routes later (e.g. a dedicated benchmark-results
 * view) doesn't mean restructuring this file.
 */

import type { JSX } from 'react';
import { Overview } from './pages/Overview.js';
import './styles.css';

export default function App(): JSX.Element {
  return <Overview />;
}