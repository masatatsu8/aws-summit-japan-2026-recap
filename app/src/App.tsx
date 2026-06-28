import { Link, NavLink, Outlet } from 'react-router-dom';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          AWS Summit Japan 2026 <span className="brand-sub">Recap</span>
        </Link>
        <nav className="topnav">
          <NavLink to="/" end className={({ isActive }) => `topnav-link ${isActive ? 'active' : ''}`}>
            ブラウズ
          </NavLink>
          <NavLink to="/ask" className={({ isActive }) => `topnav-link ${isActive ? 'active' : ''}`}>
            質問 (AI)
          </NavLink>
          <NavLink to="/lists" className={({ isActive }) => `topnav-link ${isActive ? 'active' : ''}`}>
            リスト
          </NavLink>
          <NavLink to="/bookmarks" className={({ isActive }) => `topnav-link ${isActive ? 'active' : ''}`}>
            ブックマーク
          </NavLink>
          <NavLink to="/screenshots" className={({ isActive }) => `topnav-link ${isActive ? 'active' : ''}`}>
            スクショ
          </NavLink>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <small>
          字幕は機械生成のため固有名詞の誤認識が一部含まれます。要約時に補正していますが、引用の正確性はオリジナル動画でご確認ください。
        </small>
      </footer>
    </div>
  );
}
