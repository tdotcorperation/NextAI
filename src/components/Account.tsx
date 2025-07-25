import { supabase } from '../lib/supabaseClient'

const Account = () => {
  const handleLogout = async () => {
    try {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    } catch (error) {
      alert((error as Error).message)
    }
  }

  return (
    <div className="form-widget">
      <button className="button block" onClick={handleLogout}>
        Sign Out
      </button>
    </div>
  )
}

export default Account