package com.qccontrol.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

public class RelayProtocolTest {
    @Test public void policyIsGeneratedFromAllIntentLevelMcpActions() {
        assertTrue(RelayProtocol.isAllowed("device.snapshot"));
        assertTrue(RelayProtocol.isAllowed("device.selectScene"));
        assertTrue(RelayProtocol.isAllowed("device.setParameter"));
        assertTrue(RelayProtocol.isAllowed("device.setMasterVolume"));
        assertTrue(RelayProtocol.isAllowed("device.moveBlock"));
        assertTrue(RelayProtocol.isAllowed("device.addBlock"));
        assertTrue(RelayProtocol.isAllowed("device.removeBlock"));
        assertTrue(RelayProtocol.isAllowed("device.setBlockFootswitch"));
        assertTrue(RelayProtocol.isAllowed("device.setChainInput"));
        assertTrue(RelayProtocol.isAllowed("device.setChainOutput"));
        assertTrue(RelayProtocol.isAllowed("device.setChainSplit"));
        assertTrue(RelayProtocol.isAllowed("device.listModels"));
        assertTrue(RelayProtocol.isAllowed("device.listPresets"));
        assertTrue(RelayProtocol.isAllowed("device.savePresetAs"));
        assertFalse(RelayProtocol.isAllowed("raw.hid.write"));
        assertTrue(RelayProtocol.requiresConfirmation("device.copyPreset"));
        assertTrue(RelayProtocol.requiresConfirmation("device.savePresetAs"));
        assertTrue(RelayProtocol.requiresConfirmation("device.reloadPreset"));
        assertTrue(RelayProtocol.isReadOnly("device.snapshot"));
        assertTrue(RelayProtocol.isReadOnly("device.masterVolume"));
        assertFalse(RelayProtocol.isReadOnly("device.selectScene"));
        assertFalse(RelayProtocol.isReadOnly("device.setParameter"));
        assertTrue(GeneratedRemoteActions.isPerformance("device.setTempo"));
        assertTrue(GeneratedRemoteActions.isPerformance("device.pressFootswitch"));
        assertFalse(GeneratedRemoteActions.isPerformance("device.selectScene"));
        assertTrue(GeneratedRemoteActions.isModify("device.selectScene"));
        assertTrue(GeneratedRemoteActions.isModify("device.setParameter"));
        assertFalse(GeneratedRemoteActions.isModify("device.setDeviceName"));
    }

    @Test public void endpointRequiresPlainHttpsOriginWithoutUserInfoOrQuery() {
        assertEquals("https://relay.example.com", QcRelayPlugin.normalizedEndpoint(" https://relay.example.com/ "));
        assertNull(QcRelayPlugin.normalizedEndpoint("http://relay.example.com"));
        assertNull(QcRelayPlugin.normalizedEndpoint("https://token@relay.example.com"));
        assertNull(QcRelayPlugin.normalizedEndpoint("https://relay.example.com?token=secret"));
    }
}
