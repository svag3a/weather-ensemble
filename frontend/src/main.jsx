import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import MobileApp from './MobileApp.jsx'

function isMobile() {
  return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MobileApp />} />
        <Route path="/mobile" element={<MobileApp />} />
        <Route path="/admin" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
