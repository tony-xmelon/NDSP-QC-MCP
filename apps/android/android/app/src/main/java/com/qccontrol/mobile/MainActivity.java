package com.qccontrol.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GeminiPlugin.class);
        registerPlugin(QcUsbPlugin.class);
        registerPlugin(QcRelayPlugin.class);
        registerPlugin(VoiceInputPlugin.class);
        FirebaseApp.initializeApp(this);
        FirebaseAppCheck.getInstance().installAppCheckProviderFactory(
            PlayIntegrityAppCheckProviderFactory.getInstance()
        );
        super.onCreate(savedInstanceState);
    }
}
