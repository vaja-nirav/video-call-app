# Video Call App Setup & Installation Guide

This guide walks you through setting up and running both the **Backend (NestJS + Prisma + MySQL/MariaDB)** and the **Frontend (React + Vite + Tailwind CSS)** for your video calling application.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Step 1: Set Up and Start MySQL Database](#step-1-set-up-and-start-mysql-database)
3. [Step 2: Backend Setup & Database Migration](#step-2-backend-setup--database-migration)
4. [Step 3: Frontend Setup](#step-3-frontend-setup)
5. [Step 4: Running the App and Verifying Operations](#step-4-running-the-app-and-verifying-operations)
6. [🛠️ Troubleshooting](#️-troubleshooting)

---

## 1. Prerequisites

Before starting, ensure you have the following installed on your Windows machine:
- **Node.js** (LTS Version 18+ or 20+ is highly recommended)
- **npm** (comes packaged with Node.js)
- **MySQL Server** or **MariaDB Server** running locally. You can use any of the following:
  - [XAMPP](https://www.apachefriends.org/index.html) (Very easy to start MySQL on Windows)
  - [Laragon](https://laragon.org/) (Highly recommended for Windows development)
  - [WampServer](https://www.wampserver.com/en/)
  - Standalone **MySQL Community Server**

---

## Step 1: Set Up and Start MySQL Database

1. Open your database manager (XAMPP Control Panel, Laragon, or standalone MySQL).
2. Start the **MySQL** service.
3. Ensure MySQL is running on port `3306` (default port).
4. No need to manually create the database! Prisma will automatically detect, create, and configure the database schema for you when you run the migrations in the next step.

> [!NOTE]
> By default, local MySQL installations like XAMPP or Laragon use:
> - **Username**: `root`
> - **Password**: *(empty / blank)*
> - **Host**: `localhost`
> - **Port**: `3306`
>
> If your MySQL installation has a different password (e.g., standalone MySQL installers often require a password), you must update the **`DATABASE_URL`** inside the `backend/.env` file.

---

## Step 2: Backend Setup & Database Migration

1. Open a new terminal window/tab in VS Code (or your preferred command prompt) and navigate to the **backend** folder:
   ```powershell
   cd backend
   ```

2. **Install Backend Dependencies**:
   ```bash
   npm install
   ```

3. **Verify Environment Variables**:
   Open `backend/.env` in your editor. We have pre-configured it for a standard local setup:
   ```env
   DATABASE_URL="mysql://root:@localhost:3306/video_call_app"
   PORT=3000
   JWT_SECRET="super-secret-key-12345-video-calling"
   JWT_REFRESH_SECRET="super-secret-refresh-key-67890-video-calling"
   ```
   *If your database requires a password, modify `root:@localhost` to `root:YOUR_PASSWORD@localhost`.*

4. **Run Database Migrations & Generate Prisma Client**:
   This command applies all schema definitions directly to your local MySQL server.
   ```bash
   npx prisma migrate dev --name init
   ```
   *Note: If Prisma asks to create the database `video_call_app`, type `y` or hit Enter to proceed.*

5. **Start the Backend NestJS Server in Development Mode**:
   ```bash
   npm run start:dev
   ```
   The backend will start and watch for file changes. You will see a success log saying:
   `Nest application successfully started` on port `3000`. Keep this terminal open!

---

## Step 3: Frontend Setup

1. Open a **second, separate terminal** in VS Code and navigate to the **frontend** directory:
   ```powershell
   cd frontend
   ```

2. **Install Frontend Dependencies**:
   ```bash
   npm install
   ```

3. **Start the Frontend React/Vite App**:
   ```bash
   npm run dev
   ```
   Vite will start the server and print a local address (usually `http://localhost:5173`).

---

## Step 4: Running the App and Verifying Operations

1. Open your browser and navigate to the frontend URL: `http://localhost:5173`.
2. Vite is configured with a built-in reverse-proxy in `vite.config.js`. It will automatically forward all `/auth`, `/meetings`, and `/socket.io` (WebRTC socket signaling) requests to your NestJS server on `http://localhost:3000`.
3. Try **creating an account (signing up)** and logging in. This will verify that your frontend is communicating correctly with the NestJS backend and MySQL database.
4. Try creating a meeting room to test WebSockets and dynamic video-calling capability!

---

## 🛠️ Troubleshooting

### ⚠️ Prisma Cannot Connect to the Database
If you see an error like `P1001: Can't reach database server at 'localhost':'3306'`:
1. Check if MySQL is actually running in XAMPP or your database tool.
2. Verify that your username and password are correct.
3. Make sure no other service is blocking port `3306`.

### ⚠️ Port 3000 is Already in Use
If the backend NestJS app fails to start because port 3000 is occupied:
1. Open `backend/.env` and change `PORT=3000` to a free port (e.g. `PORT=5000`).
2. Open `frontend/vite.config.js` and update all the proxy targets from `http://localhost:3000` to `http://localhost:5000`:
   ```javascript
   // frontend/vite.config.js
   proxy: {
     '/auth': { target: 'http://localhost:5000', changeOrigin: true },
     '/meetings': { target: 'http://localhost:5000', changeOrigin: true },
     '/socket.io': { target: 'http://localhost:5000', ws: true, changeOrigin: true }
   }
   ```

### ⚠️ Node.js Version Error
If you encounter npm installation failures:
1. Ensure your Node.js is up to date: `node -v` (should be `18.x`, `20.x`, or `22.x`).
2. Try deleting `node_modules` and running `npm install` again.
