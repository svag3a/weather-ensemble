import { StrictMode, useState, useEffect, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import SplashScreen from './components/SplashScreen.jsx'

const App        = lazy(() => import('./App.jsx'))
const MobileApp  = lazy(() => import('./MobileApp.jsx'))
const DesktopApp = lazy(() => import('./DesktopApp.jsx'))

function useIsDesktop() {
  const mq = window.matchMedia('(min-width: 1024px)')
  const [isDesktop, setIsDesktop] = useState(mq.matches)
  useEffect(() => {
    const handler = e => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return isDesktop
}

function Root() {
  const isDesktop = useIsDesktop()
  const [showSplash, setShowSplash] = useState(true)
  return (
    <>
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={isDesktop ? <DesktopApp /> : <MobileApp />} />
          <Route path="/mobile" element={<MobileApp />} />
          <Route path="/desktop" element={<DesktopApp />} />
          <Route path="/admin" element={<App />} />
        </Routes>
      </Suspense>
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
)
