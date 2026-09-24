/**
 * Where an invited guest lands after confirming "Leave table" (or after
 * their table closes out from under them) — see Table.tsx's leave-table
 * confirm modal. Deliberately NOT gated on `user` in App.tsx's router (it
 * renders whether or not a session still exists, since by the time a
 * guest gets here `logout()` has already cleared theirs) and deliberately
 * has no link back to the lobby, login, or account-creation — an invited
 * guest's session is fully ephemeral and this is meant to be a real dead
 * end for them, not a detour. See DECISIONS.md.
 */
export function LeftTablePage(): React.JSX.Element {
  return (
    <div className="page-centered">
      <div className="auth-card">
        <h3>You&rsquo;ve left the table</h3>
        <p>This session has ended. If you&rsquo;d like to play again, ask the table owner for a new invite link.</p>
      </div>
    </div>
  );
}
