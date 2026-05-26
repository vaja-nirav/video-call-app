import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { loginUser, loginWithGoogle, clearError } from '../features/authSlice';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState('');

  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { loading, error, isAuthenticated } = useSelector((state) => state.auth);

  useEffect(() => {
    // Clear errors when the page mounts
    dispatch(clearError());
    setValidationError('');
  }, [dispatch]);

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  // Handle Google Identity SSO Callback
  const handleGoogleCallback = (response) => {
    if (response?.credential) {
      dispatch(loginWithGoogle({ idToken: response.credential }));
    }
  };

  useEffect(() => {
    // Render Google Sign-In button once the GSI library is loaded in browser
    const initializeGoogleSSO = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: "365752923604-rdgmvemsali9e81ifc3a169h47o5i6ln.apps.googleusercontent.com",
          callback: handleGoogleCallback,
        });

        window.google.accounts.id.renderButton(
          document.getElementById("googleSignInButton"),
          { 
            theme: "filled_black", 
            size: "large", 
            width: "384", // Exact matching width for standard form fields
            height: "40", // Match py-2.5 inputs/buttons height
            text: "continue_with",
            shape: "rectangular",
            logo_alignment: "left"
          }
        );
      }
    };

    // Double check if GSI client is loaded, otherwise retry shortly
    if (window.google) {
      initializeGoogleSSO();
    } else {
      const timer = setInterval(() => {
        if (window.google) {
          initializeGoogleSSO();
          clearInterval(timer);
        }
      }, 500);
      return () => clearInterval(timer);
    }
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    setValidationError('');

    if (!email || !password) {
      setValidationError('All fields are required');
      return;
    }

    dispatch(loginUser({ email, password }));
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-dark-bg px-4">
      {/* Decorative background glows */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="w-full max-w-md glassmorphism glassmorphism-glow rounded-2xl p-8 z-10">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Welcome Back</h2>
          <p className="text-gray-400 text-sm">Sign in to start secure video calls</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Success/Error displays */}
          {(validationError || error) && (
            <div className="p-3.5 bg-red-950/40 border border-red-500/30 text-red-200 text-sm rounded-lg animate-pulse">
              {validationError || error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#08080C] border border-dark-border focus:border-indigo-500 rounded-lg py-2.5 px-4 text-white text-sm outline-none transition-all duration-300 focus:ring-1 focus:ring-indigo-500"
              placeholder="name@domain.com"
              required
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider">
                Password
              </label>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#08080C] border border-dark-border focus:border-indigo-500 rounded-lg py-2.5 px-4 text-white text-sm outline-none transition-all duration-300 focus:ring-1 focus:ring-indigo-500"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg py-2.5 text-sm transition-all duration-300 transform active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none"
          >
            {loading ? (
              <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* Separator */}
        <div className="flex items-center my-5 w-full">
          <div className="flex-grow border-t border-gray-800"></div>
          <span className="mx-3 text-[10px] font-bold text-gray-500 uppercase tracking-widest leading-none">
            Or continue with
          </span>
          <div className="flex-grow border-t border-gray-800"></div>
        </div>

        {/* Native Google SSO Container */}
        <div className="flex justify-center w-full">
          <div id="googleSignInButton" className="w-full max-w-[384px] h-[40px] flex justify-center overflow-hidden rounded-md"></div>
        </div>

        <p className="mt-8 text-center text-sm text-gray-400">
          Don't have an account?{' '}
          <Link to="/register" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
            Sign up now
          </Link>
        </p>
      </div>
    </div>
  );
};

export default Login;
