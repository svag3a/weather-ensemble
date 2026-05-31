import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

// Fix Leaflet default icon paths broken by bundlers
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Custom DivIcon: shows slot-fill indicator + label
function makeIcon(label, slotCount) {
  const fullness = Math.min(slotCount, 4)
  const colors = ['#475569', '#f97316', '#eab308', '#22c55e', '#3b82f6']
  const bg = colors[fullness]
  const html = `
    <div style="
      background:${bg};border:2px solid white;border-radius:50% 50% 50% 0;
      width:28px;height:28px;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4);
    "></div>
    <div style="
      position:absolute;top:32px;left:50%;transform:translateX(-50%);
      background:rgba(15,23,42,.85);color:white;font-size:11px;font-weight:600;
      padding:2px 6px;border-radius:4px;white-space:nowrap;
    ">${label}</div>
  `
  return L.divIcon({ className: '', html, iconSize: [28, 40], iconAnchor: [14, 28], popupAnchor: [0, -30] })
}

// Pending position icon (where user just clicked)
const pendingIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:20px;height:20px;border-radius:50%;
    background:#3b82f6;border:3px solid white;
    box-shadow:0 0 0 3px rgba(59,130,246,.4),0 2px 6px rgba(0,0,0,.3);
  "></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

// Captures map clicks
function MapClickHandler({ onMapClick }) {
  useMapEvents({
    click(e) { onMapClick(e.latlng.lat, e.latlng.lng) },
  })
  return null
}

export default function ImageMap({ locations, pendingPos, onMapClick, onPinClick }) {
  const markerRefs = useRef({})

  return (
    <div className="rounded-xl overflow-hidden border border-slate-700" style={{ height: 360 }}>
      <MapContainer
        center={[57.7089, 11.9746]}
        zoom={12}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='© <a href="https://openstreetmap.org">OSM</a>'
        />

        <MapClickHandler onMapClick={onMapClick} />

        {/* Existing location pins */}
        {locations.map(loc => {
          const slotCount = Object.keys(loc.slots).length
          const icon = makeIcon(loc.label, slotCount)
          return (
            <Marker
              key={loc.label}
              position={[loc.lat, loc.lon]}
              icon={icon}
              eventHandlers={{
                click: () => onPinClick(loc),
                dragend: (e) => {
                  const { lat, lng } = e.target.getLatLng()
                  onPinClick({ ...loc, lat, lon: lng, fromDrag: true })
                },
              }}
              draggable={true}
            >
              <Popup>
                <div className="text-sm font-medium">{loc.label}</div>
                <div className="text-xs text-gray-500">
                  {slotCount}/4 slots · {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}
                </div>
              </Popup>
            </Marker>
          )
        })}

        {/* Pending click position */}
        {pendingPos && (
          <Marker position={[pendingPos.lat, pendingPos.lon]} icon={pendingIcon}>
            <Popup>Ny plats här</Popup>
          </Marker>
        )}
      </MapContainer>

      {/* Legend */}
      <div className="absolute bottom-2 right-2 bg-slate-900/80 rounded-lg px-3 py-2 text-xs text-slate-400 space-y-1 z-[1000] pointer-events-none">
        {[['#475569','Inga bilder'],['#f97316','1 slot'],['#eab308','2 slots'],['#22c55e','3 slots'],['#3b82f6','4 slots']].map(([c,l]) => (
          <div key={l} className="flex items-center gap-2">
            <span style={{ background: c }} className="w-2.5 h-2.5 rounded-full inline-block" />
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}
