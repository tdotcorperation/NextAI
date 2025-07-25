import { useState, useEffect } from 'react'
import { supabase } from './lib/supabaseClient'
import Auth from './components/Auth'
import Chat from './components/Chat'
import type { Session } from '@supabase/supabase-js' // Changed to type-only import

function App() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
  }, [])

  return (
    <div className="h-screen">
      {!session ? <Auth /> : <Chat />}
    </div>
  )
}

export default App
