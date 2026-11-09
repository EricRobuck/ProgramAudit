import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth';
import { Layout } from './components/Layout';
import { WorkspacePage } from './pages/Workspace';
import { MyTasksPage } from './pages/MyTasks';
import { ReportPage } from './pages/Report';
import { AdminPage } from './pages/Admin';
import { AccountPage } from './pages/Account';
import './styles.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <WorkspacePage /> },
      { path: '/my-tasks', element: <MyTasksPage /> },
      { path: '/reviews/:reviewId/report', element: <ReportPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
