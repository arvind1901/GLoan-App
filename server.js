const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
// IMPORTANT: Replace './serviceAccountKey.json' with the actual path to your downloaded Firebase service account key.
// It's highly recommended to use environment variables for this path in production.
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
const serviceAccount = require(serviceAccountPath);

// Define APP_ID: Use environment variable, or a default for local testing if not in Canvas.
// This should match the `appId` used in your frontend scripts.
const APP_ID = process.env.APP_ID || 'gradious-loan-app-default'; // Choose a unique ID for your app

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Replace 'YOUR_FIREBASE_PROJECT_ID' with your actual Firebase Project ID
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID || 'YOUR_FIREBASE_PROJECT_ID'}.firebaseio.com`
});

const db = admin.firestore();
const auth = admin.auth();

// Middleware
app.use(cors()); // Enable CORS for all routes (important for frontend-backend communication)
app.use(express.json()); // Parse JSON request bodies
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from the 'public' directory

// --- API Endpoints ---

// Helper function for error handling
const handleError = (res, error, message = 'An error occurred') => {
    console.error(message, error);
    res.status(500).json({ error: message, details: error.message });
};

// 1. User Signup
app.post('/api/signup', async (req, res) => {
    const { email, password, mobile } = req.body;

    if (!email || !password || !mobile) {
        return res.status(400).json({ message: 'Email, password, and mobile are required.' });
    }

    try {
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            phoneNumber: mobile // Store mobile number
        });

        // Store additional user data in Firestore
        await db.collection('artifacts').doc(APP_ID).collection('users').doc(userRecord.uid).set({
            email: email,
            mobile: mobile,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(201).json({ message: 'User created successfully!', uid: userRecord.uid });
    } catch (error) {
        if (error.code === 'auth/email-already-in-use') {
            return res.status(409).json({ message: 'Email already registered.' });
        }
        handleError(res, error, 'Error creating user');
    }
});

// Middleware to verify Firebase ID Token
const verifyToken = async (req, res, next) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
        return res.status(401).json({ message: 'No token provided.' });
    }

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken; // Attach decoded user info to request
        next();
    } catch (error) {
        handleError(res, error, 'Invalid or expired token.');
        // Don't send 500 status here, 403 is more appropriate for auth failure
        // res.status(403).json({ message: 'Unauthorized: Invalid or expired token.' }); // Removed to avoid double send
    }
};

// 3. Submit Loan Application (Protected Route)
app.post('/api/apply-loan', verifyToken, async (req, res) => {
    const { loanType, purpose, panNumber, requestedLoanAmount, monthlyEmi, totalInterest, principalAmount, totalAmountPayable, idProofFileName } = req.body;
    const userId = req.user.uid; // Get user ID from verified token

    if (!loanType || !purpose || !panNumber || !requestedLoanAmount) {
        return res.status(400).json({ message: 'Missing required loan application fields.' });
    }

    try {
        // Store loan application in a user-specific subcollection
        const loanApplicationRef = await db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('loanApplications').add({
            userId: userId,
            loanType,
            purpose,
            panNumber,
            requestedLoanAmount,
            monthlyEmi,
            totalInterest,
            principalAmount,
            totalAmountPayable,
            idProofFileName, // Store filename, though the file itself isn't uploaded here
            status: 'Pending', // Initial status
            appliedDate: admin.firestore.FieldValue.serverTimestamp()
        });

        // Also add to a central applications collection for easier admin access
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('allApplications').doc(loanApplicationRef.id).set({
            userId: userId,
            loanType,
            purpose,
            panNumber,
            requestedLoanAmount,
            monthlyEmi,
            totalInterest,
            principalAmount,
            totalAmountPayable,
            idProofFileName,
            status: 'Pending', // Initial status
            appliedDate: admin.firestore.FieldValue.serverTimestamp(),
            applicationId: loanApplicationRef.id // Store the ID for easy lookup
        });


        res.status(201).json({ message: 'Loan application submitted successfully!', applicationId: loanApplicationRef.id });
    } catch (error) {
        handleError(res, error, 'Error submitting loan application');
    }
});

// 4. Get Loan Status for a User (Protected Route)
app.get('/api/loan-status', verifyToken, async (req, res) => {
    const userId = req.user.uid;

    try {
        const snapshot = await db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('loanApplications').get();
        const applications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(applications);
    } catch (error) {
        handleError(res, error, 'Error fetching loan status');
    }
});

// 5. Get All Loan Applications for Admin (Protected Route - requires admin role check)
app.get('/api/admin/applications', verifyToken, async (req, res) => {
    // IMPORTANT: In a real application, you would add a role check here
    // For example:
    // const userDoc = await db.collection('artifacts').doc(APP_ID).collection('users').doc(req.user.uid).get();
    // if (!userDoc.exists || userDoc.data().role !== 'admin') {
    //     return res.status(403).json({ message: 'Access denied: Admin privileges required.' });
    // }

    try {
        // Fetch from the central collection for admin view
        const snapshot = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('allApplications').get();
        const applications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(applications);
    } catch (error) {
        handleError(res, error, 'Error fetching all loan applications for admin');
    }
});

// 6. Update Loan Application Status by Admin (Protected Route - requires admin role check)
app.put('/api/admin/applications/:id/status', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { status, repayment } = req.body; // status: 'Approved', 'Rejected', 'Pending', repayment: 'Paid', '-' etc.

    // IMPORTANT: In a real application, you would add a role check here
    // const userDoc = await db.collection('artifacts').doc(APP_ID).collection('users').doc(req.user.uid).get();
    // if (!userDoc.exists || userDoc.data().role !== 'admin') {
    //     return res.status(403).json({ message: 'Access denied: Admin privileges required.' });
    // }

    if (!status) {
        return res.status(400).json({ message: 'Status is required.' });
    }

    try {
        // Update in the central applications collection
        const centralAppRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('allApplications').doc(id);
        await centralAppRef.update({ status: status, repayment: repayment || null });

        // Also update in the user's specific collection
        const appData = (await centralAppRef.get()).data();
        if (appData && appData.userId) {
            await db.collection('artifacts').doc(APP_ID).collection('users').doc(appData.userId).collection('loanApplications').doc(id).update({
                status: status,
                repayment: repayment || null
            });
        }

        res.status(200).json({ message: `Application ${id} status updated to ${status}.` });
    } catch (error) {
        handleError(res, error, 'Error updating application status');
    }
});

// Serve the index.html for any unmatched routes (SPA-like behavior, for fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
});