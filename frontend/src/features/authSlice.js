import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../utils/api';

// Async Thunk for User Registration
export const registerUser = createAsyncThunk(
  'auth/register',
  async ({ name, email, password }, thunkAPI) => {
    try {
      const response = await api.post('/auth/register', { name, email, password });
      return response.data; // Expected { user, accessToken, refreshToken }
    } catch (error) {
      const message = error.response?.data?.message || 'Registration failed';
      return thunkAPI.rejectWithValue(message);
    }
  }
);

// Async Thunk for User Login
export const loginUser = createAsyncThunk(
  'auth/login',
  async ({ email, password }, thunkAPI) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      return response.data; // Expected { user, accessToken, refreshToken }
    } catch (error) {
      const message = error.response?.data?.message || 'Login failed';
      return thunkAPI.rejectWithValue(message);
    }
  }
);

// Async Thunk for Google Login
export const loginWithGoogle = createAsyncThunk(
  'auth/googleLogin',
  async ({ idToken }, thunkAPI) => {
    try {
      const response = await api.post('/auth/google-login', { idToken });
      return response.data; // Expected { user, accessToken, refreshToken }
    } catch (error) {
      const message = error.response?.data?.message || 'Google Login failed';
      return thunkAPI.rejectWithValue(message);
    }
  }
);

// Async Thunk for User Logout
export const logoutUser = createAsyncThunk(
  'auth/logout',
  async (_, thunkAPI) => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // Even if network logout fails, we clear state locally
      console.warn('Network logout failed, clearing local session anyway.', error);
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
    }
  }
);

const initialState = {
  user: JSON.parse(localStorage.getItem('user')) || null,
  accessToken: localStorage.getItem('accessToken') || null,
  refreshToken: localStorage.getItem('refreshToken') || null,
  isAuthenticated: !!localStorage.getItem('accessToken'),
  loading: false,
  error: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
    // Restores state from localStorage (run on boot)
    restoreAuth: (state) => {
      const user = localStorage.getItem('user');
      const accessToken = localStorage.getItem('accessToken');
      const refreshToken = localStorage.getItem('refreshToken');
      if (user && accessToken && refreshToken) {
        state.user = JSON.parse(user);
        state.accessToken = accessToken;
        state.refreshToken = refreshToken;
        state.isAuthenticated = true;
      } else {
        state.user = null;
        state.accessToken = null;
        state.refreshToken = null;
        state.isAuthenticated = false;
      }
    }
  },
  extraReducers: (builder) => {
    builder
      // Register
      .addCase(registerUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(registerUser.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
        state.refreshToken = action.payload.refreshToken;
        state.isAuthenticated = true;
        
        localStorage.setItem('user', JSON.stringify(action.payload.user));
        localStorage.setItem('accessToken', action.payload.accessToken);
        localStorage.setItem('refreshToken', action.payload.refreshToken);
        localStorage.setItem('meetsync_first_time', 'true');
      })
      .addCase(registerUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })
      // Login
      .addCase(loginUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
        state.refreshToken = action.payload.refreshToken;
        state.isAuthenticated = true;

        localStorage.setItem('user', JSON.stringify(action.payload.user));
        localStorage.setItem('accessToken', action.payload.accessToken);
        localStorage.setItem('refreshToken', action.payload.refreshToken);
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })
      // Google Login
      .addCase(loginWithGoogle.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loginWithGoogle.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
        state.refreshToken = action.payload.refreshToken;
        state.isAuthenticated = true;

        localStorage.setItem('user', JSON.stringify(action.payload.user));
        localStorage.setItem('accessToken', action.payload.accessToken);
        localStorage.setItem('refreshToken', action.payload.refreshToken);
        if (action.payload.isNewUser) {
          localStorage.setItem('meetsync_first_time', 'true');
        }
      })
      .addCase(loginWithGoogle.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })
      // Logout
      .addCase(logoutUser.fulfilled, (state) => {
        state.user = null;
        state.accessToken = null;
        state.refreshToken = null;
        state.isAuthenticated = false;
        state.loading = false;
        state.error = null;
      });
  },
});

export const { clearError, restoreAuth } = authSlice.actions;
export default authSlice.reducer;
