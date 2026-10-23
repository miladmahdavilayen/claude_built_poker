import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Where an invited guest lands after confirming "Leave table" (or after
 * their table closes out from under them) — see Table.tsx's leave-table
 * confirm modal. Deliberately NOT gated on `user` in App.tsx's router, and
 * with no link to the lobby, login, or account creation: a guest's way
 * back is the invite link they came by, which keeps working for as long as
 * the table is open (their seat invite belongs to them — see the server's
 * LiveTable.redeemSeatAssignment). Leaving never closes the table.
 */
export function LeftTablePage(): React.JSX.Element {
  const navigate = useNavigate();
  const state = (useLocation().state ?? null) as { rejoin?: string | null; tableName?: string } | null;
  const rejoin = state?.rejoin ?? null;
  return (
    <div className="page-centered">
      <div className="auth-card left-table-card">
        <h3>You&rsquo;ve left {state?.tableName ? <>&ldquo;{state.tableName}&rdquo;</> : 'the table'}</h3>
        {rejoin ? (
          <>
            <p>Your chips are set aside for you. Come back any time while the table is open &mdash; here, or with the same invite link.</p>
            <button type="button" className="btn-primary" onClick={() => void navigate(rejoin)}>
              Rejoin table
            </button>
          </>
        ) : (
          <p>To play again, open the invite link the table owner sent you &mdash; it keeps working while the table is open.</p>
        )}
      </div>
    </div>
  );
}
