'use client';

import { Blobatar } from '@blobatar/react';
import 'blobatar/motion.css';

/** Generated here from the account id: the same account is always the same face, and nothing is requested from anywhere. */
export function UserAvatar({ account, size }: { account: string; size: number }) {
  return <Blobatar name={account} size={size} animate="always" className="shrink-0" aria-hidden="true" />;
}
