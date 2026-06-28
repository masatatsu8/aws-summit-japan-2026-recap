import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import AskPage from './pages/Ask';
import BrowsePage from './pages/Browse';
import BookmarksPage from './pages/Bookmarks';
import ListsPage from './pages/Lists';
import ScreenshotsPage from './pages/Screenshots';
import SessionPage from './pages/Session';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <BrowsePage /> },
      { path: 'ask', element: <AskPage /> },
      { path: 'bookmarks', element: <BookmarksPage /> },
      { path: 'lists', element: <ListsPage /> },
      { path: 'screenshots', element: <ScreenshotsPage /> },
      { path: 'sessions/:slug', element: <SessionPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
