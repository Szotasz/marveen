# fiREG import enum-szótár -- HITELES (Attila/Hori, 2026-06-25)

A kódok BETŰHÍVEN használandók (a vegyes kis/nagybetű és az elírásszerű kódok is a
rendszer tényleges értékei -- ne "javítsd"). Minden dátum-cella (karbantartás /
felülvizsgálat / ellenőrzés / nyomáspróba): Excel cellatípus = SZÖVEG, formátum `éééé-hh-nn` (ISO YYYY-MM-DD).

KEF PDF doktípus -> kategória: TK=tűzoltókészülék, TV=vízforrás, EA=világítás,
TG=tűzgátló, HFR=hő-füst. (A tűzjelző / oltórendszer / defibrillátor / létra nem KEF-PDF
típus, de a fiREG import ugyanígy kéri.)

## Vízforrás (TV) -- tuzivizforras-sablon-vizforras_import.xlsx
| Típus | Kód |
|---|---|
| Föld alatti tűzcsap | fold_alatti_tuzcsap |
| Föld feletti tűzcsap | fold_feletti_tuzcsap |
| Hűtőtorony vízmedencéje, technológiai víz | hutotorony_vizmedenceje |
| Nedves fali tűzcsap | nedves_fali_tuzcsap |
| Nyitott medence/tartály | nyitott_medence |
| Nyomásfokozó szivattyú | nyomasfokozo_szivattyu |
| Száraz fali tűzcsap | szaraz_fali_tuzcsap |
| Száraz tűzivízvezeték | szaraz_tuzivizvezetek |
| Szerelvény szekrény | szerelveny_szekreny |
| Természetes vízforrás | termeszetes_vizforras |
| Vízmű víztároló | vizmu_viztarolo |
| Zárt medence/tartály | zart_medence |

Altípus/űrtartalom: medence=méret (M 180); tűzcsap=tömlő iránymutatás (Lapostömlő, Merevtömlő).
Szerelvények/csonkok (vesszővel): B 75 lapostömlő, B 75 csonkkapocs, B 75 sugárcső, C 52 lapostömlő, C 52 csonkkapocs, D 25 lapostömlő, D 25 merevtömlő, D 25 csonkkapocs, E 38 lapostömlő, E 38 merevtömlő, B - C áttéti darab, C - D áttéti darab, C 52 sugárcső, D 25 sugárcső, E 38 sugárcső, 110-es szívócsonk, Állványcső, Kapocspárkulcs, Kupakkapocs, Föld alatti tűzcsapkulcs, Föld feletti tűzcsapkulcs, Egyetemes kapocspárkulcs, Száraz felszálló vezeték, Gyűjtő, Osztó, D25 alaktartó tömlős tűzcsap rendszer, D33 alaktartó tömlős tűzcsap rendszer, B 75 vízpajzs, C 52 vízpajzs, Lábszelepes szűrő, Bekötő tömlő

## Tűzgátló (TG) -- tuzgato-sablon-fire_doors_hu.xlsx
| Típus | Kód |
|---|---|
| Egyéb | egyeb |
| Légpótló ajtó | legpotlo_ajto |
| Légpótló kapu | legpotlo_kapu |
| Tűz és füstgátló ajtó | tuz_fustgatlo_ajto |
| Tűz és füstgátló kapu | tuz_fustgatlo_kapu |
| Tűzgátló ajtó | tuzgatlo_ajto |
| Tűzgátló ajtó pánikzárral | tuzgatlo_ajto_panikzarral |
| Tűzgátló csappantyú | tuzgatlo_csappantyu |
| Tűzgátló kapu | tuzgatlo_kapu |
| Tűzgátló mobil függöny | tuzgatlo_mobil_fuggony |
| Tűzgátló szervizajtó | tuzgatlo_szervizajto |
| Tűzgátló tömítés | tuzgatlo_tomites |
| Tűzgátló üveg | tuzgatlo_uveg |
| Tűzgátló zsalu | tuzgatlo_zsalu |
| Tűzoltó takaró | tuzgatlo_takaro |
| Vezérlő központ | vezerlo_kozpont |

Tűzállóság: T 15, T 30, T 45, T 60, T 90, T 120
Szerelvények: Ajtókitámasztó, Ajtónyitó motor, Ajtótartó mágnes, Akkumulátor, Automata küszöb, Bordás szíjas sebességszabályozó, Csúszó sines ajtóbehúzó, Elektromechanikus ajtómozgató, Központ, Lapra szerelt ajtóbehúzó, Mágneszár, Pánikzár, RWA tartómágnes, Sorrendszabályzó, Súlyszekrény, Ütköző, Vezetőgörgő, Zár, Zárbetét, Zsanéros ajtóbehúzó, Szünetmentes táp, Motoros szelep, Mágnesszelep, Vésznyitó kapcsoló, Vészzáró kapcsoló

## Hő- és füstelvezetés (HFR) -- fustgato-sablon-hofustelvezeto_import.xlsx
| Típus | Kód |
|---|---|
| Donga | donga |
| Füstcsappantyú | fustcsappantyu |
| Füstelszívó ventillátor | fustelszivo_ventilator |
| Füstelvezető ablak | fustelvezeto_ablak |
| Füstelvezető ajtó | fustelvezeto_ajto |
| Füstgátló ajtó | fustgatlo_ajto |
| Füstkötényfal | fustkotenyfal |
| Füstmentesítő ventillátor | fustmentesito_ventilator |
| Füstzsalu | fustzsalu |
| Indítóállomás | inditoallomas |
| Indítógomb | inditogomb |
| Központ | kozpont |
| Kupola | kupola |
| Légpótló ventillátor | legpotlo_ventilator |
| Légutánpótló ablak | legutanpotlo_ablak |
| Légutánpótló ajtó | legutanpotlo_ajto |
| Légutánpótló kapu | legutanpotlo_kapu |
| Mobil füstkötény | mobil_fustkoteny |
| Nyílószárny | nyiloszarny |
| Oldalfalu zsalu | oldalfalu_zsalu |
| Sáv felülvilágító | sav_felvilagitas |
| Tetőzsalu | tetozsalu |
| Tűz és füstgátló ajtó | tuz_fustgatlo_ajto |
| Tűz és füstgátló kapu | tuz_fustgatlo_kapu |
| Vésznyitó | vesznyito |
| Vezérlés | vezerles |

Szerelvények: Hőampulla, Palack, Druckgasgenerator, Rasant, Akkumulátor, RWA Motor, Szellőztető motor, RWA Munkahenger, Szellőztető munkahenger, Gázrugó, TAG szelep, Fékező dugattyú, Nyitómotor, Zár motor, Előfeszített nyitószerkezet, Szél érzékelő, Eső érzékelő, Kézi jelzésadó, Tartómágnes

## Világítás (EA) -- vilagitas-sablon-vilagitas_import.xlsx
| Típus | Kód |
|---|---|
| Biztonsági világítás | biztonsagi_vilagitas |
| Egyedi világítás | egyedi_vilagitas |
| Irányfény világítás | iranyfeny_vilagitas |
| Menekülési jel (alacsonyan telepített megvilágított) | menekulesi_jel_magas |
| Menekülési jel (középmagasan telepített megvilágított) | menekulesi_jel_kozepmagas |
| Menekülési jel (magasan telepített megvilágított) | menekulesi_jel_alacsony |
| Pánik elleni világítás | panik_elleni_vilagitas |
| Tartalékvilágítás | tartalekvilagitas |
| Utánvilágító jel | utanvilagito_jel |

(FIGYELEM: az alacsony/magas a forrásban "fordítottnak" tűnik, de a kód a hiteles -- így használd.)
Szerelvények: Akkumulátor

## Vészkijárat / menekülési ajtó -- veszkijarat-sablon-veszkijaratimport.xlsx
| Típus | Kód |
|---|---|
| Egyedi ajtó | egyedi_ajto |
| Menekülési ajtó | menekulesi_ajto |
| Menekülési ajtó tűzgátló funkcióval | menekulesi_ajto_tuzgatlo_funkcioval |
| Pánikzáras ajtó | panikzaras_ajto |
| Vészkijárati ajtó | veszkijarati_ajto |

Szerelvények: Ajtókitámasztó, Ajtótartó mágnes, Elektromos zár, Előfeszített nyitószerkezet, Gázrugó, Lapraszerelt ajtóbehúzó

## Tűzjelző -- tuzjelzo-sablon-tuzjelzo_eszkozok_import.xlsx
| Típus | Kód |
|---|---|
| Ajtótartó mágnes | ajtotarto_magnes |
| Akkumulátor | akkumulator |
| Aljzat alatti hangjelző | ALJZAT_ALATTI_HANGJELZO |
| Aspirációs érzékelő | aspiracios_erzekelo |
| Átjelző berendezés | atjelzo_berendezes |
| Be/kimeneti modul | BE_KI_MODUL |
| Bemeneti modul | bemeneti_modul |
| Bemeneti pont | bemeneti_pont |
| Eszköz illesztési pont | eszkoz_illesztesi_pont |
| Fény és hangjelző sziréna | feny_hangjelzo_szirena |
| Füstérzékelő | fust_erzekelo |
| Hangjelző | hangjelzo |
| Hőérzékelő | ho_erzekelo |
| Hőérzékelő kábel | hoerzekelo_kabel |
| Huroktáplált hang, fényjelző | HUROKTAPLALT_HANG_FENYJELZO |
| Huroktáplált hangjelző | HUROKTAPLALT_HANGJELZO |
| Illesztő modul | illeszto_modul |
| Kézi jeladó | kezi_jelado |
| Kijelző tabló | kijelzo_tablo |
| Kimeneti modul | kimeneti_modul |
| Kimeneti pont | kimeneti_pont |
| Kombinált érzékelő | kombinalt_erzekelo |
| Központ modul | kozpont_modul |
| Kulcsszéf | kulcsszef |
| Láng érzékelő | lang_erzekelo |
| Légcsatorna érzékelő | legcsatorna_erzekelo |
| Lineáris hőérzékelő | linearis_hoerzekelo |
| Másodkijelző | masodkijelzo |
| Optikai érzékelő | optikai_erzekelo |
| Rb-s kézi jeladó | RB_KEZI_JELADÓ |
| Rb-s kombinált érzékelő | RB_KOMBINALT_ERZEKELO |
| RF illesztő modul | RF_ILLESZTO_MODUL |
| RF kézi jeladó | RF_KEZI_JELADO |
| RF kombinált érzékelő | RF_KOMBINALT_ERZEKELO |
| Segéd tápegység | seged_tapegyseg |
| Távkezelő | tavkezelo |
| Tűzjelző központ | tuzjelzo_kozpont |
| Vonali füst érzékelő | vonali_fust_erzekelo |
| Vonali hőérzékelő | vonal_erzekelo |

## Oltórendszer / sprinkler -- oltorendszer-sablon-tuzolto_eszkozok_import.xlsx
| Típus | Kód |
|---|---|
| Akkumulátor | AKKUMULATOR |
| Alközpont | ALKOZPONT |
| Áramkapcsoló | ARAMKAPCSOLOO |
| Áramlásérzékelők és nyomáskapcsolók | ARAMERZEKELO |
| Áramláskapcsoló | ARAMLASKAPCSOLO |
| Aspirációs füstérzékelő | ASPIRACIOS_FUSTERZEKELO |
| Csőhálózat | CSOHALOZAT |
| Dízel meghajtású sprinklerszivattyú | DIZEL_SZIVATTYU |
| Eláraztátos riasztószelep | ELARAZTASOS_RIASZTOSZELEP |
| Elektromos meghajtású sprinklerszivattyú | ELEKTROMOS_SZIVATTYU |
| Elővezérelt riasztószelep | ELOVEZERELT_RIASZTOSZELEP |
| Elzáró szerelvény | ELZARO_SZERELVENY |
| Feltöltő szivattyú | FELTOLTO_SZIVATTYU |
| Feltöltőtartály | FELTOLTOTARTALY |
| Felügyelő berendezés | FELUGYELO |
| Fúvóka | FUVOKA |
| Gázérzékelő | GAZERZEKELO |
| Generátor | GENERATOR |
| Hang- és fényjelző | HANG_ES_FENYJELZO |
| Hangjelző | HANGJELZO |
| Hibajelző | HIBAJELZO |
| Hőérzékelő | HOERZEKELO |
| Kézi indító | KEZI_INDITO |
| Kézi jelzésadó | KEZI_JELZESADO |
| Kézi oltásblokkoló | KEZI_OLTASBLOKKOLO |
| Kombinált érzékelő | HOERZEKELOHOERZEKELO |
| Kompresszor | KOMPRESSOR |
| Köztes tartály | KOZTES_TARTALY |
| Lángérzékelő | LANGERZEKELO |
| Légcsatorna érzékelő | LEGCSATORNA_ERZEKELO |
| Légnyomásos tartály | LEGNYOMASOS_TARTALY |
| Levegőnyomásos víztartály | LEVEGO_NYOMASOS_VIZTARTALY |
| Nedves riasztószelepek | NEDVES_SZELEP |
| Nyitás érzékelő | NYITAS_ERZEKELO |
| Nyomáskapcsoló | NYOMASKAPCSOLO |
| Nyomástartó szivattyú | NYOMASTARTO_SZIVATTYU |
| Oltásvezérlő | OLTASVEZERLO |
| Oltógáz | OLTOGAZ |
| Oltógáz tartály | OLTOGAZ_TARTALY |
| Oltótartály | OLTOTARTALY |
| Optikai füstérzékelő | OPTIKAI_FUSTERZEKELO |
| Osztó | OSZTO |
| Palack | PALACK |
| Riasztó | RIASZTO |
| Sprinkler fej | SPRINKLER_FEJ |
| Sprinkler gépház | GEPHAZ |
| Sprinkler víztartály | VIZTARTALY |
| Sűrített levegős víztartály | SURITETT_TARTALY |
| Sűrített levegős víztartály tápláló szivattyú | SURITETT_TARTALY_SZIVATTYU |
| Száraz riasztószelepek | SZARAZ_SZELEP |
| Szelep állomás | SZELEP_ALLOMAS |
| Szivattyú | SZIVATTYU |
| Tábla | TABLA |
| Tabló | TABLO |
| Túlnyomás-leeresztő szerkezetek | TULNYOMAS_LEERESZTO_SZERKEZET |
| Tűzoltó csatlakozó | TUZOLTO_CSATLAKOZO |
| Tűzoltó eszköz | tuzolto_eszkoz |
| Tűzoltó központ | tuzolto_kozpont |
| Tűzoltósági betáp | TUZOLTOSAGI_BETAP |
| Úszószelep | USZOSZELEP |
| Védett terület | VEDETT_TERULET |
| Végállás kapcsoló | VEGALLAS_KAPCSOLO |
| Vízcsatlakozás | VIZCSATLAKOZAS |
| Vízmotorral hajtott riasztó berendezések | VIZMOTOR_RIASZTO |
| Zsompszivattyú | ZSOMPSZIVATTYU |

## Defibrillátor (AED) -- márka/típus -> numerikus kód
0 HeartSine Samaritan PAD 300P | 1,4 HeartSine PAD 350P | 2,5 HeartSine PAD 360P | 3,6 HeartSine PAD 500P
7 Medtronic LIFEPAK CR Plus | 12 Medtronic LIFEPAK 1000 | 15 Medtronic LIFEPAK 500
8 Physio Control LIFEPAK CR Plus | 10 Physio LIFEPAK CR2 | 13 Physio LIFEPAK 1000 | 16 Physio LIFEPAK 500
9 Stryker LIFEPAK CR Plus | 11 Stryker LIFEPAK CR2 | 14 Stryker LIFEPAK 1000
17 SaverONE SVO-B001 | 18 SVO-B002 | 19 SVO-B847 | 20 SVO-B848 | 21 SaverOne D SVD-B0004 | 22 SVD-B0005 | 23 SVD-B0006 | 24 SaverOneP SVD-B0007 | 25 Smarty Saver
26 Zoll AED PLUS | 27 Zoll AED 3 | 28 Zoll PowerHeart G5
29 CardiacScience PowerHeart G5 | 30 PowerHeart G3
31 INNOMED PowerHeart G3 | 32 INNOMED Cardio Aid 100B
33 Schiller DefiSign LIFE (Fred PA-1) | 34 Fred PA-1 | 35 Fred Easy | 36 Fred Easyport
37 CU Medical NF-1200 | 38 CU Medical I-PAD CU-SP1 | 39 Medical Econet I-PAD ME SP1
40 Defibtech Lifeline AED | 41 Lifeline VIEW AED | 42 Lifeline ECG AED | 43 Lifeline PRO AED
44 METsis Life-Point PRO AED | 45 Life-Point bPLUS AED
46 NanoomTech HeartPlus NT-180
47 Philips HeartStart FR3 | 48 HeartStart FRx | 49 HeartStart HS1
50 Metrax HeartStart | 51 Primedic HeartSave ONE | 52 Primedic HeartSave AED | 53 AED-M | 54 AED 6 | 55 AED 6S
56 PROGETTI Rescue Sam | 57 Mediana HeartOn A15
58 Mindray BeneHeart C1A | 59 BeneHeart C2 | 60 BeneHeart D
61 Cardio-Aid 360-B | 62 Medical CardioAid 1AED | 63 CardiAid CT 0207 RS

Szerelvények: Akkumulátor, Telep, Felnőtt elektróda, Gyermek elektróda, Készenléti helyet jelző tábla, Tároló vitrin és riasztó

## Létra
| Típus | Kód |
|---|---|
| Egymásba illesztett támasztó létra | EGYMASBA_ILLESZTETT_TAMASZTO_LETRA |
| Emelvényes létra | EMELVENYES_LETRA |
| Gördülő támasztó létra | GORDULO_TAMASZTO_LETRA |
| Háztartási létra | HAZTARTASI_LETRA |
| Kitolható támasztó létra | KITOLHATO_TAMASZTO_LETRA |
| Kétágú létra | KETAGU_LETRA |
| Létraállvány | LETRAALLVANY |
| Tetőlétra | TETOLETRA |
| Többcélú létra | TOBBCELU_LETRA |
| Építési létraállvány | EPITESI_LETRAALLVANY |
