package com.qccontrol.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the relay's device credential encrypted by a non-exportable Android Keystore key. */
final class RelayCredentialStore {
    private static final String ALIAS = "qc_control_relay_device_v1";
    private static final String PREFS = "qc_relay_secure";
    private static final String ENDPOINT = "endpoint";
    private static final String CREDENTIAL = "credential";

    private final Context context;

    RelayCredentialStore(Context context) { this.context = context.getApplicationContext(); }

    synchronized void save(String endpoint, String credential) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(credential.getBytes(StandardCharsets.UTF_8));
        byte[] value = new byte[cipher.getIV().length + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, value, 0, cipher.getIV().length);
        System.arraycopy(encrypted, 0, value, cipher.getIV().length, encrypted.length);
        prefs().edit().putString(ENDPOINT, endpoint).putString(CREDENTIAL,
            Base64.encodeToString(value, Base64.NO_WRAP)).apply();
    }

    synchronized String endpoint() { return prefs().getString(ENDPOINT, null); }

    synchronized String credential() throws Exception {
        String encoded = prefs().getString(CREDENTIAL, null);
        if (encoded == null) return null;
        byte[] value = Base64.decode(encoded, Base64.NO_WRAP);
        if (value.length < 13) throw new IllegalStateException("Stored relay credential is invalid.");
        byte[] iv = new byte[12];
        byte[] encrypted = new byte[value.length - 12];
        System.arraycopy(value, 0, iv, 0, 12);
        System.arraycopy(value, 12, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    synchronized boolean paired() { return endpoint() != null && prefs().contains(CREDENTIAL); }

    synchronized void clear() { prefs().edit().clear().apply(); }

    private SharedPreferences prefs() { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }
}
